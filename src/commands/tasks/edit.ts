import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import { getTaskDetail } from '../../api/tasks.js';
import {
  addLabelsPath,
  addTaskLabels,
  buildEditTaskBody,
  editTask,
  editTaskPath,
  isEmptyEditBody,
  removeLabelsPath,
  removeTaskLabels,
} from '../../api/tasks-edit.js';
import {
  type EditTaskBody,
  type EditTaskInput,
  type EditWouldEntry,
  type TasksEditData,
} from '../../api/schemas/task.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderTasksEditHuman } from '../../ui/human/tasks-edit.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.edit/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.tasks.edit/v1';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PRIORITY_VALUES = ['low', 'normal', 'high'] as const;
type Priority = (typeof PRIORITY_VALUES)[number];

type EditOpts = {
  name?: string;
  worker?: number[];
  due?: string;
  priority?: Priority;
  clearPriority?: true;
  addLabel?: string[];
  removeLabel?: string[];
  dryRun?: true;
  project?: number;
};

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

function collectPositiveInt(label: string) {
  return (raw: string, prev: number[] | undefined): number[] => {
    const n = parsePositiveIntFlag(label, `${label} takes a positive integer (numeric id).`, raw);
    return prev ? [...prev, n] : [n];
  };
}

function collectNonEmptyString(label: string) {
  return (raw: string, prev: string[] | undefined): string[] => {
    if (raw.length === 0) {
      throw new ValidationError(`${label} cannot be empty.`, {
        hintNext: `${label} takes a non-empty value (e.g. ${label} bug).`,
      });
    }
    return prev ? [...prev, raw] : [raw];
  };
}

function parseDateFlag(label: string, raw: string): string {
  if (!ISO_DATE.test(raw)) {
    throw new ValidationError(`${label} must be in YYYY-MM-DD format.`, {
      hintNext: 'Use ISO date format, e.g. 2026-04-01.',
    });
  }
  const t = Date.parse(`${raw}T00:00:00Z`);
  if (Number.isNaN(t)) {
    throw new ValidationError(`${label} is not a valid date.`, {
      hintNext: 'Use a real calendar date in YYYY-MM-DD format.',
    });
  }
  return raw;
}

function parsePriority(raw: string): Priority {
  if (!(PRIORITY_VALUES as readonly string[]).includes(raw)) {
    throw new ValidationError(`--priority must be one of: ${PRIORITY_VALUES.join(', ')}.`, {
      hintNext: `--priority valid values: ${PRIORITY_VALUES.join(', ')}.`,
    });
  }
  return raw as Priority;
}

/**
 * Pick the first `--worker` value to send on the wire; collapse repeats into
 * a `notice` string (or undefined if there's no notice to emit). Same shape
 * as R09's helper — copied here intentionally rather than shared, because the
 * notice text differs and the helper has no other callers yet.
 *
 * Spec 0020 §3.4 / decision 7.
 */
function pickWorkerWithNotice(workers: number[] | undefined): {
  workerId: number | undefined;
  notice: string | undefined;
} {
  if (workers === undefined || workers.length === 0) {
    return { workerId: undefined, notice: undefined };
  }
  if (workers.length === 1) {
    return { workerId: workers[0], notice: undefined };
  }
  const [first, ...rest] = workers;
  return {
    workerId: first,
    notice: `--worker repeated; only the first id was used. Discarded: ${rest.join(', ')}.`,
  };
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerEdit(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = tasks
    .command('edit')
    .description('Partially update a task: name, due date, worker, priority, and label diff.')
    .argument('<id>', 'Task id (positive integer).', parseTaskId)
    .option('--name <str>', 'Rename the task. Empty string is rejected.')
    .option(
      '--worker <id>',
      'Reassign to user id (numeric). Repeatable; only the first id is sent (see envelope notice).',
      collectPositiveInt('--worker'),
    )
    .option('--due <date>', 'New due date (YYYY-MM-DD).', (raw) => parseDateFlag('--due', raw))
    .option(
      '--priority <level>',
      'New priority: low, normal, or high (mutex with --clear-priority).',
      parsePriority,
    )
    .option('--clear-priority', 'Clear the priority (mutex with --priority).')
    .option(
      '--add-label <name>',
      'Add a label by name (repeatable). Server defaults color when label is new.',
      collectNonEmptyString('--add-label'),
    )
    .option(
      '--remove-label <name>',
      'Remove a label by name (repeatable). NAME-ONLY MATCH IS AGGRESSIVE — every label with that name is removed regardless of color.',
      collectNonEmptyString('--remove-label'),
    )
    .option('--dry-run', 'Skip every POST; envelope echoes the call set that would have been made.')
    .option(
      '--project <id>',
      'Project id (only allowed with --dry-run; skips the task lookup GET).',
      (raw) =>
        parsePositiveIntFlag(
          '--project',
          '--project is only valid with --dry-run; otherwise the project id is derived from <id>.',
          raw,
        ),
    );
  attachMeta(cmd, meta);

  cmd.action(async (id: number, opts: EditOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      const { editInput, addLabels, removeLabels, workerNotice } = validateAndDeriveInputs(opts);
      await runEdit(id, editInput, addLabels, removeLabels, workerNotice, opts, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Flag validation + derivation
 * ------------------------------------------------------------------------- */

type DerivedInputs = {
  editInput: EditTaskInput;
  addLabels: string[];
  removeLabels: string[];
  workerNotice: string | undefined;
};

function validateAndDeriveInputs(opts: EditOpts): DerivedInputs {
  // --priority + --clear-priority mutex
  if (opts.priority !== undefined && opts.clearPriority === true) {
    throw new ValidationError('Pick either --priority or --clear-priority, not both.', {
      hintNext: 'Use --priority to set a value; --clear-priority to remove it.',
    });
  }
  if (opts.name !== undefined && opts.name.length === 0) {
    throw new ValidationError('--name cannot be empty.', {
      hintNext: 'Pass a non-empty task name, or omit --name.',
    });
  }
  if (opts.project !== undefined && opts.dryRun !== true) {
    throw new ValidationError('--project is only valid with --dry-run.', {
      hintNext:
        'Drop --project; the project id is derived from <id>. Or add --dry-run to skip the lookup.',
    });
  }

  const { workerId, notice: workerNotice } = pickWorkerWithNotice(opts.worker);

  // Dedupe add/remove case-sensitively (decision 14), preserving first-seen order.
  const addLabels = dedupePreserve(opts.addLabel ?? []);
  const removeLabels = dedupePreserve(opts.removeLabel ?? []);

  // Same-name in both → reject (decision 8).
  const removeSet = new Set(removeLabels);
  for (const name of addLabels) {
    if (removeSet.has(name)) {
      throw new ValidationError(
        `Label '${name}' is in both --add-label and --remove-label; pick one.`,
        { hintNext: 'Decide whether the label should end up on the task or off, then pass one.' },
      );
    }
  }

  const editInput: EditTaskInput = {};
  if (opts.name !== undefined) editInput.name = opts.name;
  if (opts.due !== undefined) editInput.due = opts.due;
  if (workerId !== undefined) editInput.worker = workerId;
  if (opts.priority !== undefined) editInput.priority = opts.priority;
  if (opts.clearPriority === true) editInput.clearPriority = true;

  // At-least-one-mutating-flag rule (decision 3).
  const hasEdit = Object.keys(editInput).length > 0;
  if (!hasEdit && addLabels.length === 0 && removeLabels.length === 0) {
    throw new ValidationError(
      'At least one of --name, --worker, --due, --priority, --clear-priority, --add-label, --remove-label is required.',
      { hintNext: 'Pass at least one mutating flag, or use `freelo tasks show <id>` to read.' },
    );
  }

  return { editInput, addLabels, removeLabels, workerNotice };
}

function dedupePreserve(arr: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 *  Orchestration
 * ------------------------------------------------------------------------- */

async function runEdit(
  taskId: number,
  editInput: EditTaskInput,
  addLabels: string[],
  removeLabels: string[],
  workerNotice: string | undefined,
  opts: EditOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const editBody = buildEditTaskBody(editInput);

  // ---- Dry-run + --project: zero HTTP at all (decision 13).
  if (opts.dryRun === true && opts.project !== undefined) {
    const wouldList = buildWouldList(taskId, editBody, addLabels, removeLabels);
    const data: TasksEditData = {
      tasklist_id: null,
      project_id: opts.project,
      applied_changes: {
        edit: editBody as Record<string, unknown>,
        labels_added: addLabels,
        labels_removed: removeLabels,
      },
      would: wouldList,
    };
    writeDryRunEnvelope(taskId, data, mode, appConfig, workerNotice);
    return;
  }

  // ---- Need an HTTP client (lookup at minimum).
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

  // ---- Lookup: fetch the task to derive tasklist_id / project_id.
  // Failure here aborts: a 404 / 403 surfaces as `FreeloApiError`; no further
  // calls are attempted. Calibration §4: this catch arm has a test row.
  const lookup = await getTaskDetail(client, taskId, {
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  const tasklistId = lookup.data.tasklist?.id ?? null;
  const projectId = lookup.data.project?.id ?? null;

  // ---- Dry-run without --project: lookup ran, but no POSTs.
  if (opts.dryRun === true) {
    const wouldList = buildWouldList(taskId, editBody, addLabels, removeLabels);
    const data: TasksEditData = {
      tasklist_id: tasklistId,
      project_id: projectId,
      applied_changes: {
        edit: editBody as Record<string, unknown>,
        labels_added: addLabels,
        labels_removed: removeLabels,
      },
      would: wouldList,
    };
    writeDryRunEnvelope(taskId, data, mode, appConfig, workerNotice);
    return;
  }

  // ---- Live fan-out.
  // Order: remove-labels → add-labels → edit-body → refresh-GET (decision 9).
  // `applied_changes` only records what *succeeded* (decision 12). Any throw
  // here propagates verbatim; the user sees the failed call and what already
  // landed in the optimistic CLI message (in the future — for v1 we let the
  // error envelope speak for itself).
  const accumulator: TasksEditData['applied_changes'] = {
    edit: {},
    labels_added: [],
    labels_removed: [],
  };
  let lastRateLimit = lookup.rateLimit;

  if (removeLabels.length > 0) {
    const result = await removeTaskLabels(client, taskId, removeLabels, {
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    accumulator.labels_removed = result.names;
    if (result.raw !== null) lastRateLimit = result.raw.rateLimit;
  }

  if (addLabels.length > 0) {
    const result = await addTaskLabels(client, taskId, addLabels, {
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    accumulator.labels_added = result.names;
    if (result.raw !== null) lastRateLimit = result.raw.rateLimit;
  }

  if (!isEmptyEditBody(editBody)) {
    const result = await editTask(client, {
      taskId,
      body: editBody,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    accumulator.edit = editBody as Record<string, unknown>;
    lastRateLimit = result.raw.rateLimit;
  }

  // ---- Refresh GET. On failure, emit success-with-notice (decision 11).
  let refreshedTask: TasksEditData['task'] = null;
  let refreshNotice: string | undefined;
  try {
    const refresh = await getTaskDetail(client, taskId, {
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    refreshedTask = refresh.data;
    lastRateLimit = refresh.rateLimit;
  } catch (err: unknown) {
    // Calibration §4: this catch arm has a dedicated test row.
    const detail =
      err instanceof BaseError ? err.message : err instanceof Error ? err.message : String(err);
    refreshNotice = `Edit applied; post-edit refresh GET failed: ${detail}. data.task is null — refetch with \`freelo tasks show ${taskId}\`.`;
  }

  const data: TasksEditData = {
    task: refreshedTask,
    tasklist_id: tasklistId,
    project_id: projectId,
    applied_changes: accumulator,
  };
  // Compose the success-line notice. If both worker notice AND refresh notice
  // exist, concatenate them — agents read `notice` as a single human string.
  const notices: string[] = [];
  if (workerNotice !== undefined) notices.push(workerNotice);
  if (refreshNotice !== undefined) notices.push(refreshNotice);
  const noticeOpt = notices.length > 0 ? notices.join(' ') : undefined;

  const envelope: Envelope<TasksEditData> = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: lastRateLimit.remaining,
      reset_at: lastRateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    ...(noticeOpt !== undefined ? { notice: noticeOpt } : {}),
  });
  writeEnvelope(taskId, envelope, mode);
}

/* ---------------------------------------------------------------------------
 *  Helpers
 * ------------------------------------------------------------------------- */

function buildWouldList(
  taskId: number,
  editBody: EditTaskBody,
  addLabels: readonly string[],
  removeLabels: readonly string[],
): EditWouldEntry[] {
  const list: EditWouldEntry[] = [];
  if (removeLabels.length > 0) {
    list.push({
      method: 'POST',
      path: removeLabelsPath(taskId),
      body: { labels: removeLabels.map((name) => ({ name })) },
    });
  }
  if (addLabels.length > 0) {
    list.push({
      method: 'POST',
      path: addLabelsPath(taskId),
      body: { labels: addLabels.map((name) => ({ name })) },
    });
  }
  if (!isEmptyEditBody(editBody)) {
    list.push({
      method: 'POST',
      path: editTaskPath(taskId),
      body: editBody,
    });
  }
  return list;
}

function writeDryRunEnvelope(
  taskId: number,
  data: TasksEditData,
  mode: 'human' | 'json' | 'ndjson',
  appConfig: PartialAppConfig,
  workerNotice: string | undefined,
): void {
  // Construct the envelope inline — `dryRunEnvelope` from `src/lib/dry-run.ts`
  // assumes a single `Would` (R09 shape); R10's `would` is an array. Building
  // here keeps the shared helper's contract intact (spec 0020 decision 5).
  const envelope: Envelope<TasksEditData> = {
    schema: SCHEMA,
    data,
    dry_run: true,
  };
  if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
  if (workerNotice !== undefined) envelope.notice = workerNotice;
  writeEnvelope(taskId, envelope, mode);
}

function writeEnvelope(
  taskId: number,
  envelope: Envelope<TasksEditData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const line = renderTasksEditHuman(taskId, envelope.data);
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
