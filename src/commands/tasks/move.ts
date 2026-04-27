/**
 * `freelo tasks move <id>` (R12, spec 0022).
 *
 * Single-id, optionally cross-project move via
 * `POST /task/{task_id}/move/{tasklist_id}`. The destination project is
 * **derived from `--to-tasklist`** server-side (OpenAPI :1842-1891); the
 * optional `--to-project` flag is a CLI-side post-hoc assertion (spec 0022
 * decision 2).
 *
 * Flow:
 *   1. Validate flags.
 *   2. Pre-check `GET /task/{id}` to learn the source tasklist/project AND
 *      enable idempotent skip if the task is already in the target tasklist.
 *   3. If already in target → emit envelope with `already_in_target_tasklist:
 *      true`, no POST, no refresh GET.
 *   4. If `--dry-run` → emit envelope with `would`, no POST, no refresh GET.
 *   5. POST the move, then refresh GET to surface the post-move shape.
 *   6. If `--to-project` was supplied AND the post-move project mismatches,
 *      emit a `notice` (exit stays 0; the move did succeed).
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { getTaskDetail } from '../../api/tasks.js';
import { moveTask, movePath } from '../../api/tasks-move.js';
import { type TasksMoveData, type TaskState } from '../../api/schemas/task.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderTasksMoveHuman } from '../../ui/human/tasks-move.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { BaseError } from '../../errors/base.js';
import { checkIdempotency } from '../../lib/idempotency.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.move/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.tasks.move/v1';

type MoveOpts = {
  toTasklist?: number;
  toProject?: number;
  dryRun?: true;
};

/* ---------------------------------------------------------------------------
 *  Input parsing
 * ------------------------------------------------------------------------- */

/**
 * Parse the `<id>` positional. Throws `ValidationError` (BaseError, exitCode
 * 2) — NOT Commander's `InvalidArgumentError` (calibration §1-2).
 */
function parseTaskId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('<id> must be a positive integer.', {
      hintNext: '<id> is the numeric task id from `freelo tasks list`.',
    });
  }
  return n;
}

function parsePositiveIntFlag(label: string, hint: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`${label} must be a positive integer.`, { hintNext: hint });
  }
  return n;
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerMove(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = tasks
    .command('move')
    .description(
      'Move a task between tasklists (optionally cross-project). Idempotent: tasks already in the target tasklist are skipped.',
    )
    .argument('<id>', 'Task id (positive integer).', parseTaskId)
    .requiredOption(
      '--to-tasklist <id>',
      'Destination tasklist id (positive integer). Required.',
      (raw) =>
        parsePositiveIntFlag(
          '--to-tasklist',
          '--to-tasklist takes the numeric tasklist id from `freelo tasklists list`.',
          raw,
        ),
    )
    .option(
      '--to-project <id>',
      'Optional project assertion. The destination project is server-derived from --to-tasklist; this flag adds a post-move sanity check (notice on mismatch).',
      (raw) =>
        parsePositiveIntFlag(
          '--to-project',
          '--to-project takes the numeric project id; it is a post-move assertion only.',
          raw,
        ),
    )
    .option(
      '--dry-run',
      'Skip the POST. Pre-check GET still runs so the envelope reflects observed state and the `would` block is exact.',
    );
  attachMeta(cmd, meta);

  cmd.action(async (id: number, opts: MoveOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // `requiredOption` ensures `toTasklist` is set; defensive narrowing.
      if (opts.toTasklist === undefined) {
        throw new ValidationError('--to-tasklist is required.', {
          hintNext: '--to-tasklist takes the numeric destination tasklist id.',
        });
      }
      await runMove(id, opts.toTasklist, opts, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Orchestration (single-id flow)
 * ------------------------------------------------------------------------- */

async function runMove(
  taskId: number,
  toTasklistId: number,
  opts: MoveOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const client = await buildClient(appConfig, env);

  // ---- 1. Pre-check via GET /task/{id}.
  const lookup = await getTaskDetail(client, taskId, {
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  const fromTasklistId = lookup.data.tasklist?.id ?? null;
  const fromProjectId = lookup.data.project?.id ?? null;
  const observedState = deriveObservedState(lookup.data.state);
  let lastRateLimit = lookup.rateLimit;

  // ---- 2. Refuse on `'deleted'` (decision 9).
  if (observedState === 'deleted') {
    throw new ValidationError(`Task ${taskId} is deleted; cannot move a deleted task.`, {
      hintNext: 'Deleted tasks are not addressable via move. Restore via the Freelo UI first.',
    });
  }

  // ---- 3. Idempotency check on tasklist id (pure helper, no I/O).
  // When `from_tasklist_id` is null (defensive — passthrough may let null
  // through), idempotency cannot be proven; proceed with the move and let
  // the API decide. The shared `checkIdempotency` helper is generic over
  // string-typed states (R11 ships `TaskState`); we stringify the integer
  // ids so the helper's contract holds (the comparison is exact-equality,
  // both sides are coerced the same way).
  const check =
    fromTasklistId === null
      ? { alreadyInTargetState: false }
      : checkIdempotency<string>({
          observedState: String(fromTasklistId),
          targetState: String(toTasklistId),
        });

  // ---- 4a. Already in target → emit envelope, NO POST, NO refresh GET.
  // When `--dry-run` is set AND the pre-check shows already-in-target, the
  // envelope still carries `dry_run: true` (no POST WOULD have happened
  // anyway — the dry-run flag is a property of the invocation, not of the
  // server interaction). The `would` block is OMITTED because no POST would
  // have run even live (spec 0022 §3.2 / decision 6).
  if (check.alreadyInTargetState) {
    const data: TasksMoveData = {
      task_id: taskId,
      from_tasklist_id: fromTasklistId,
      to_tasklist_id: toTasklistId,
      from_project_id: fromProjectId,
      to_project_id: fromProjectId, // unchanged (no move happened)
      already_in_target_tasklist: true,
      task: lookup.data,
    };
    const envelope = buildSuccessEnvelope(data, lastRateLimit, appConfig);
    if (opts.dryRun === true) envelope.dry_run = true;
    writeEnvelope(envelope, mode);
    return;
  }

  // ---- 4b. Dry-run: skip the POST + refresh, emit envelope with `would`.
  if (opts.dryRun === true) {
    const data: TasksMoveData = {
      task_id: taskId,
      from_tasklist_id: fromTasklistId,
      to_tasklist_id: toTasklistId,
      from_project_id: fromProjectId,
      // We do NOT fetch the destination tasklist's project in dry-run
      // (decision 6); to_project_id stays null until a real move happens.
      to_project_id: null,
      already_in_target_tasklist: false,
      task: lookup.data,
      would: {
        method: 'POST',
        path: movePath(taskId, toTasklistId),
        body: {},
      },
    };
    const envelope: Envelope<TasksMoveData> = {
      schema: SCHEMA,
      data,
      dry_run: true,
    };
    if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
    writeEnvelope(envelope, mode);
    return;
  }

  // ---- 4c. Live POST.
  const moveResult = await moveTask(client, taskId, toTasklistId, {
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  lastRateLimit = moveResult.raw.rateLimit;

  // ---- 5. Refresh GET. On failure, emit success-with-notice (decision 8).
  let refreshedTask: TasksMoveData['task'] = null;
  let toProjectId: number | null = null;
  let refreshNotice: string | undefined;
  try {
    const refresh = await getTaskDetail(client, taskId, {
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    refreshedTask = refresh.data;
    toProjectId = refresh.data.project?.id ?? null;
    lastRateLimit = refresh.rateLimit;
  } catch (err: unknown) {
    // Calibration §4: this catch arm has a dedicated test row.
    const detail =
      err instanceof BaseError ? err.message : err instanceof Error ? err.message : String(err);
    refreshNotice = `Move applied; post-move refresh GET failed: ${detail}. data.task is null — refetch with \`freelo tasks show ${taskId}\`.`;
  }

  // ---- 6. --to-project assertion (post-hoc; only emit notice on mismatch).
  let assertionNotice: string | undefined;
  if (opts.toProject !== undefined && toProjectId !== null && opts.toProject !== toProjectId) {
    assertionNotice = `--to-project asserted ${opts.toProject} but post-move task is in project ${toProjectId}. Verify destination tasklist id and the project graph.`;
  }

  const data: TasksMoveData = {
    task_id: taskId,
    from_tasklist_id: fromTasklistId,
    to_tasklist_id: toTasklistId,
    from_project_id: fromProjectId,
    to_project_id: toProjectId,
    already_in_target_tasklist: false,
    task: refreshedTask,
  };
  const notices: string[] = [];
  if (refreshNotice !== undefined) notices.push(refreshNotice);
  if (assertionNotice !== undefined) notices.push(assertionNotice);
  const noticeOpt = notices.length > 0 ? notices.join(' ') : undefined;

  const envelope: Envelope<TasksMoveData> = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: lastRateLimit.remaining,
      reset_at: lastRateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    ...(noticeOpt !== undefined ? { notice: noticeOpt } : {}),
  });
  writeEnvelope(envelope, mode);
}

/* ---------------------------------------------------------------------------
 *  Helpers
 * ------------------------------------------------------------------------- */

async function buildClient(
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<HttpClient> {
  const creds = await resolveCredentials({
    profile: appConfig.profile,
    apiBaseUrl: appConfig.apiBaseUrl,
    env,
  });
  return createHttpClient({
    email: creds.email,
    apiKey: creds.apiKey,
    apiBaseUrl: creds.apiBaseUrl,
    userAgent: appConfig.userAgent,
  });
}

/**
 * Derive the observed `TaskState` from `TaskDetail.state`. Defensive: null
 * / missing block → `'active'` (most permissive default; mirrors R11
 * `transition.ts`). Unknown enum value → `'active'` for the same reason.
 */
function deriveObservedState(state: { state?: string | null } | null | undefined): TaskState {
  const raw = state?.state;
  if (
    raw === 'active' ||
    raw === 'archived' ||
    raw === 'finished' ||
    raw === 'deleted' ||
    raw === 'template'
  ) {
    return raw;
  }
  return 'active';
}

function buildSuccessEnvelope(
  data: TasksMoveData,
  rateLimit: { remaining: number | null; resetAt: string | null },
  appConfig: PartialAppConfig,
): Envelope<TasksMoveData> {
  return buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: rateLimit.remaining,
      reset_at: rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
}

function writeEnvelope(envelope: Envelope<TasksMoveData>, mode: 'human' | 'json' | 'ndjson'): void {
  if (mode === 'human') {
    const line = renderTasksMoveHuman(envelope.data);
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
