import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import {
  buildEditTasklistBody,
  editTasklist,
  editTasklistPath,
  isEmptyEditBody,
} from '../../api/tasklists-edit.js';
import {
  type EditTasklistBody,
  type EditTasklistInput,
  type TasklistsEditData,
} from '../../api/schemas/tasklist.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderTasklistsEditHuman } from '../../ui/human/tasklists-edit.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { confirmDestructive } from '../../lib/confirm.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

/**
 * M02 — `freelo tasklists edit <id>` (spec 0065).
 *
 * `meta.destructive` is **false**: the command deletes nothing, and the
 * confirmation gate below is conditional on a single flag
 * (`--should-change-existing-tasks`), which the whole-command `destructive`
 * boolean cannot express. Marking it `true` would tell every agent that
 * `tasklists edit --name Foo` destroys data, which is false. See decision 5.
 */
export const meta: CommandMeta = {
  outputSchema: 'freelo.tasklists.edit/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.tasklists.edit/v1';

type EditOpts = {
  name?: string;
  budget?: string;
  clearBudget?: true;
  timeBudgetMinutes?: number;
  clearTimeBudget?: true;
  worker?: number;
  clearWorker?: true;
  trackingUsers?: number[];
  clearTrackingUsers?: true;
  shouldChangeExistingTasks?: true;
  priority?: number;
  dryRun?: true;
};

/* ---------------------------------------------------------------------------
 *  Flag parsers.
 *
 *  Every one throws `ValidationError` (BaseError, exit 2) — NOT Commander's
 *  `InvalidArgumentError`, which falls through to exit 1 (calibration §1-2).
 * ------------------------------------------------------------------------- */

/** Parse the `<id>` positional. */
function parseTasklistId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('<id> must be a positive integer.', {
      hintNext: '<id> is the numeric tasklist id from `freelo tasklists list`.',
    });
  }
  return n;
}

/**
 * Parse `--budget <amount>`. Freelo wire format is an integer amount in
 * **minor currency units** encoded as a string — "100000" is 1000.00.
 *
 * Decimal strings are rejected by the server with a bare 400 that does not
 * explain why (yaml :1272), so we reject them here with a message that does.
 * The value is passed through verbatim; converting client-side would risk
 * float-precision drift.
 *
 * Semantically identical to `parseBudgetFlag` in `./create.ts` — kept local
 * on purpose (decision 3; `src/lib/money.ts` does not exist).
 */
function parseBudgetFlag(raw: string): string {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new ValidationError('--budget must be a non-negative integer string (no separator).', {
      hintNext:
        '--budget is in minor currency units, e.g. "100000" for 1000.00. Decimals like "100.50" are rejected. Use --clear-budget to remove the budget.',
    });
  }
  return trimmed;
}

/** Parse an integer flag with an inclusive lower bound. */
function parseIntFlag(label: string, min: number, hint: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new ValidationError(
      min === 0
        ? `${label} must be an integer of 0 or more.`
        : `${label} must be a positive integer.`,
      { hintNext: hint },
    );
  }
  return n;
}

/**
 * Parse `--priority <n>`.
 *
 * THE NAMING TRAP (spec 0065 §2.2): this is the tasklist's **position within
 * its project**, not an importance level. It is the third distinct meaning of
 * "priority" in this API after task `order_by=priority` (#108) and the
 * unrelated `priority_enum` (low/normal/high). Both the message and the hint
 * say so explicitly, because a user who has seen `priority_enum` will
 * otherwise pass `high` here and get a confusing error.
 */
function parsePriorityFlag(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(
      '--priority must be a positive integer (1 = first position in the project).',
      {
        hintNext:
          "--priority is the tasklist's POSITION within its project, not an importance level. For task importance see `freelo tasks edit --priority low|normal|high`.",
      },
    );
  }
  return n;
}

/** Repeatable positive-int accumulator (decision 7 — repeatable, not variadic). */
function collectPositiveInt(label: string, hint: string) {
  return (raw: string, prev: number[] | undefined): number[] => {
    const n = parseIntFlag(label, 1, hint, raw);
    return prev ? [...prev, n] : [n];
  };
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerEdit(
  tasklists: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = tasklists
    .command('edit')
    .description(
      'Partially update a tasklist: name, budget, time fund, followers, default worker, and position within its project. Only the flags you pass are changed.',
    )
    .argument('<id>', 'Tasklist id (positive integer).', parseTasklistId)
    .option('--name <str>', 'Rename the tasklist. Empty string is rejected.')
    .option(
      '--budget <amount>',
      'Budget in minor currency units as digits only, e.g. 100000 for 1000.00. Decimals are rejected. Mutex with --clear-budget.',
      parseBudgetFlag,
    )
    .option('--clear-budget', 'Remove the budget (sends null). Mutex with --budget.')
    .option(
      '--time-budget-minutes <n>',
      'Time fund in whole minutes (0 or more). 0 is a real value meaning a zero fund, not a clear. Mutex with --clear-time-budget.',
      (raw) =>
        parseIntFlag(
          '--time-budget-minutes',
          0,
          '--time-budget-minutes takes whole minutes, 0 or more. Use --clear-time-budget to remove the fund entirely.',
          raw,
        ),
    )
    .option(
      '--clear-time-budget',
      'Remove the time fund (sends null). Mutex with --time-budget-minutes.',
    )
    .option(
      '--worker <id>',
      'Set the default worker to this user id. Mutex with --clear-worker.',
      (raw) =>
        parseIntFlag(
          '--worker',
          1,
          '--worker is the numeric user id (e.g. from `freelo projects workers`).',
          raw,
        ),
    )
    .option('--clear-worker', 'Remove the default worker (sends null). Mutex with --worker.')
    .option(
      '--tracking-users <id>',
      'Follower user id. REPEATABLE — pass the flag once per user; the ids you give replace the whole follower set. User ids without access to the tasklist are silently dropped by Freelo and are NOT reported back. Mutex with --clear-tracking-users.',
      collectPositiveInt(
        '--tracking-users',
        '--tracking-users takes a numeric user id and is repeatable, e.g. --tracking-users 12 --tracking-users 34.',
      ),
    )
    .option(
      '--clear-tracking-users',
      'Remove all followers (sends an empty list). Mutex with --tracking-users.',
    )
    .option(
      '--should-change-existing-tasks',
      'Also apply the follower change to EVERY existing task in the tasklist. Wide blast radius and not reported back by the API, so it requires --yes (or a TTY confirmation). Only valid together with --tracking-users or --clear-tracking-users.',
    )
    .option(
      '--priority <n>',
      'Move the tasklist to position <n> within its project (1 = first). POSITIONAL ORDER, NOT IMPORTANCE — unrelated to task priority (low/normal/high). Other tasklists shift to fill the gap; values past the end clamp to last. Applied outside the main transaction: if it fails the other fields still save and the envelope reports priority_applied=false.',
      parsePriorityFlag,
    )
    .option('--dry-run', 'Skip the POST; the envelope echoes the body that would have been sent.');
  attachMeta(cmd, meta);

  // NOTE: `--yes` / `-y` is the **global** flag registered on the root
  // program, so subcommand opts do not carry it. Read via `resolveYesFlag`.
  cmd.action(async (id: number, opts: EditOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      const input = validateAndDeriveInput(opts);
      await runEdit(id, input, opts, resolveYesFlag(cmd), appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/**
 * Walk the Commander tree to the root program and read the global `--yes`
 * (`-y`) flag. Mirrors `src/commands/files/delete.ts:216-225`.
 *
 * Defensive: if the root cannot be reached (detached command in a test
 * harness), fall back to `false` — the safe default.
 */
function resolveYesFlag(cmd: Command): boolean {
  let cur: Command | null = cmd;
  while (cur && cur.parent) {
    cur = cur.parent;
  }
  if (cur === null) return false;
  const opts = cur.opts<{ yes?: boolean }>();
  return opts.yes === true;
}

/* ---------------------------------------------------------------------------
 *  Flag validation + derivation (spec 0065 §5)
 * ------------------------------------------------------------------------- */

function validateAndDeriveInput(opts: EditOpts): EditTasklistInput {
  // --- Rule 2: the four mutex pairs.
  assertMutex(
    opts.budget !== undefined,
    opts.clearBudget === true,
    '--budget',
    '--clear-budget',
    'Use --budget to set an amount; --clear-budget to remove it.',
  );
  assertMutex(
    opts.timeBudgetMinutes !== undefined,
    opts.clearTimeBudget === true,
    '--time-budget-minutes',
    '--clear-time-budget',
    'Use --time-budget-minutes to set a fund (0 is allowed); --clear-time-budget to remove it.',
  );
  assertMutex(
    opts.worker !== undefined,
    opts.clearWorker === true,
    '--worker',
    '--clear-worker',
    'Use --worker to set the default worker; --clear-worker to remove it.',
  );
  assertMutex(
    opts.trackingUsers !== undefined,
    opts.clearTrackingUsers === true,
    '--tracking-users',
    '--clear-tracking-users',
    'Use --tracking-users to set the follower list; --clear-tracking-users to remove everyone.',
  );

  // --- Rule 3: --name must be non-empty after trim.
  let name: string | undefined;
  if (opts.name !== undefined) {
    const trimmed = opts.name.trim();
    if (trimmed.length === 0) {
      throw new ValidationError('--name cannot be empty.', {
        hintNext: 'Pass a non-empty tasklist name, or omit --name.',
      });
    }
    name = trimmed;
  }

  // --- Rule 10: --should-change-existing-tasks needs a follower change.
  const hasFollowerChange = opts.trackingUsers !== undefined || opts.clearTrackingUsers === true;
  if (opts.shouldChangeExistingTasks === true && !hasFollowerChange) {
    throw new ValidationError(
      '--should-change-existing-tasks requires --tracking-users or --clear-tracking-users.',
      {
        hintNext:
          '--should-change-existing-tasks only propagates a follower change to existing tasks; on its own there is nothing to propagate and Freelo would ignore it.',
      },
    );
  }

  const input: EditTasklistInput = {};
  if (name !== undefined) input.name = name;
  if (opts.budget !== undefined) input.budget = opts.budget;
  if (opts.clearBudget === true) input.clearBudget = true;
  if (opts.timeBudgetMinutes !== undefined) input.timeBudgetMinutes = opts.timeBudgetMinutes;
  if (opts.clearTimeBudget === true) input.clearTimeBudget = true;
  if (opts.worker !== undefined) input.worker = opts.worker;
  if (opts.clearWorker === true) input.clearWorker = true;
  if (opts.trackingUsers !== undefined) input.trackingUsers = opts.trackingUsers;
  if (opts.clearTrackingUsers === true) input.clearTrackingUsers = true;
  if (opts.shouldChangeExistingTasks === true) input.shouldChangeExistingTasks = true;
  if (opts.priority !== undefined) input.priority = opts.priority;

  // --- Rule 9: at-least-one-mutating-flag (mirrors R10 decision 3).
  // `--should-change-existing-tasks` does not count on its own — but rule 10
  // above already guarantees a follower change accompanies it, so reaching
  // here with only that flag set is impossible.
  if (isEmptyEditBody(buildEditTasklistBody(input))) {
    throw new ValidationError(
      'At least one of --name, --budget, --clear-budget, --time-budget-minutes, --clear-time-budget, --worker, --clear-worker, --tracking-users, --clear-tracking-users, --priority is required.',
      {
        hintNext:
          'Pass at least one mutating flag, or use `freelo tasklists show <id>` to read the tasklist.',
      },
    );
  }

  return input;
}

function assertMutex(
  setFlag: boolean,
  clearFlag: boolean,
  setName: string,
  clearName: string,
  hint: string,
): void {
  if (setFlag && clearFlag) {
    throw new ValidationError(`Pick either ${setName} or ${clearName}, not both.`, {
      hintNext: hint,
    });
  }
}

/* ---------------------------------------------------------------------------
 *  Orchestration
 * ------------------------------------------------------------------------- */

async function runEdit(
  tasklistId: number,
  input: EditTasklistInput,
  opts: EditOpts,
  yes: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const body = buildEditTasklistBody(input);
  const priorityRequested = input.priority !== undefined;

  // --- Confirmation gate (decision 5). Only when the wide-blast-radius flag
  //     is set. `--yes` bypasses; `--dry-run` skips (no effect to guard);
  //     non-TTY without `--yes` throws ConfirmationError (exit 2).
  if (input.shouldChangeExistingTasks === true) {
    await confirmDestructive({
      promptMessage: propagationPrompt(tasklistId, input.clearTrackingUsers === true),
      yes,
      dryRun: opts.dryRun === true,
    });
  }

  // --- Dry-run: zero HTTP.
  if (opts.dryRun === true) {
    const data: TasklistsEditData = {
      tasklist_id: tasklistId,
      priority_requested: priorityRequested,
      // Dry-run makes no claim about a call it did not make; `would` is the
      // signal that nothing happened.
      priority_applied: true,
      applied_changes: body,
      would: {
        method: 'POST',
        path: editTasklistPath(tasklistId),
        body,
      },
    };
    const envelope: Envelope<TasklistsEditData> = {
      schema: SCHEMA,
      data,
      dry_run: true,
    };
    if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
    writeEnvelope(envelope, mode);
    return;
  }

  // --- Live POST.
  const creds = await resolveCredentials({
    profile: appConfig.profile,
    apiBaseUrl: appConfig.apiBaseUrl,
    env,
  });
  const client = createHttpClient({
    email: creds.email,
    apiKey: creds.apiKey,
    apiBaseUrl: creds.apiBaseUrl,
    userAgent: appConfig.userAgent,
  });

  let result: Awaited<ReturnType<typeof editTasklist>>;
  try {
    result = await editTasklist(client, {
      tasklistId,
      body,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    throw rewriteApiHint(err);
  }

  // --- Partial-success handling (decision 4). Exit code stays 0; the state
  //     is expressed as a required envelope field plus a notice.
  const priorityApplied = result.response.priorityApplied;
  const data: TasklistsEditData = {
    tasklist_id: tasklistId,
    priority_requested: priorityRequested,
    priority_applied: priorityApplied,
    applied_changes: body,
  };

  const notice =
    priorityRequested && !priorityApplied
      ? `Tasklist updated, but the priority reorder was NOT applied (server reported priorityApplied=false). All other fields committed. Retry the reorder alone with: freelo tasklists edit ${tasklistId} --priority ${String(body.priority)}`
      : undefined;

  const envelope = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: result.raw.rateLimit.remaining,
      reset_at: result.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    ...(notice !== undefined ? { notice } : {}),
  });
  writeEnvelope(envelope, mode);
}

/**
 * Confirmation copy for `--should-change-existing-tasks`. The clear-all case
 * gets its own wording because it is materially worse: it strips every
 * follower from every task, and the API returns no record of what it touched.
 *
 * For humans only — agents pass `--yes` and never see this.
 */
function propagationPrompt(tasklistId: number, clearing: boolean): string {
  return clearing
    ? `--should-change-existing-tasks with --clear-tracking-users will REMOVE ALL FOLLOWERS from EVERY existing task in tasklist #${tasklistId}. Continue?`
    : `--should-change-existing-tasks will propagate this follower change to EVERY existing task in tasklist #${tasklistId}. Continue?`;
}

/* ---------------------------------------------------------------------------
 *  Output
 * ------------------------------------------------------------------------- */

function writeEnvelope(
  envelope: Envelope<TasklistsEditData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    process.stdout.write(`${renderTasklistsEditHuman(envelope.data)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Map `FreeloApiError` to a friendlier `hintNext` for the well-known cases.
 * Returns the original value unchanged for non-`FreeloApiError` inputs and
 * statuses we do not specialize. Mirrors `./create.ts:227-258`.
 */
function rewriteApiHint(err: unknown): unknown {
  if (!(err instanceof FreeloApiError)) return err;

  const hint = hintForStatus(err.httpStatus);
  if (hint === undefined) return err;

  return new FreeloApiError(err.message, err.code, {
    ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
    errors: err.errors,
    rawBody: err.rawBody,
    hintNext: hint,
  });
}

function hintForStatus(status: number | undefined): string | undefined {
  if (status === 400) {
    return 'Server-side validation rejected the edit. If you passed --budget it must be digits-only minor units (e.g. 100000 for 1000.00), never a decimal.';
  }
  if (status === 403) {
    return 'Account does not have permission to edit this tasklist.';
  }
  if (status === 404) {
    return 'Tasklist not found, or your account does not have access.';
  }
  return undefined;
}

/** Re-exported for the unit tests of the wire body shape. */
export type { EditTasklistBody };
