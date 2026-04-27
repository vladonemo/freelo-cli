import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { getTasklistDetail } from '../../api/tasklists.js';
import {
  buildCreateTaskBody,
  createTask,
  createTaskPath,
  type CreateTaskResult,
} from '../../api/tasks-create.js';
import {
  type CreateTaskInput,
  type TaskCreated,
  type TasksCreateData,
} from '../../api/schemas/task.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import {
  renderTasksCreateHuman,
  renderBatchLineFailureHuman,
  renderBatchLineSuccessHuman,
} from '../../ui/human/tasks-create.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.create/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.tasks.create/v1';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PRIORITY_VALUES = ['low', 'normal', 'high'] as const;
type Priority = (typeof PRIORITY_VALUES)[number];

type CreateOpts = {
  tasklist?: number;
  name?: string;
  worker?: number[];
  due?: string;
  priority?: Priority;
  label?: string[];
  description?: string;
  descriptionFile?: string;
  dryRun?: boolean;
  stdin?: boolean;
  project?: number;
};

/**
 * Parse a positive-integer flag. Throws `ValidationError` (BaseError, exit 2)
 * — NOT Commander's `InvalidArgumentError` which would map to exit 1
 * (calibration §1-2).
 */
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
 * Per-line NDJSON shape — keys mirror the long-form CLI flags with kebab→snake
 * conversion. `tasklist` is **rejected** (decision 6); `description_file` is
 * **rejected** (decision 5). Unknown keys fail via `.strict()`.
 *
 * We do not validate `tasklist`/`description_file` via the schema — they are
 * caught in `validateBatchLine` so we can emit a precise hint. Other unknown
 * keys are caught by `.strict()` itself.
 */
const BatchLineSchema = z
  .object({
    name: z.string().min(1, "'name' must be a non-empty string"),
    worker: z.number().int().positive().optional(),
    due: z.string().regex(ISO_DATE, "'due' must be in YYYY-MM-DD format").optional(),
    priority: z.enum(PRIORITY_VALUES).optional(),
    label: z.array(z.string().min(1)).optional(),
    description: z.string().optional(),
    // Reserved keys — present here so `.strict()` does NOT reject them; the
    // command-level validator emits a more precise error than zod.
    tasklist: z.unknown().optional(),
    description_file: z.unknown().optional(),
  })
  .strict();

type BatchLine = z.infer<typeof BatchLineSchema>;

/**
 * Map a parsed NDJSON line to a `CreateTaskInput`. Catches the two reserved-
 * key cases (decision 5, decision 6) before they would otherwise become
 * silently-accepted no-ops.
 */
function batchLineToInput(line: BatchLine, lineIndex: number): CreateTaskInput {
  if (line.tasklist !== undefined) {
    throw new ValidationError(`Line ${lineIndex + 1}: per-line 'tasklist' is not allowed.`, {
      hintNext: 'Pass --tasklist on the command line, not in NDJSON lines.',
    });
  }
  if (line.description_file !== undefined) {
    throw new ValidationError(
      `Line ${lineIndex + 1}: 'description_file' is not allowed in batch mode.`,
      {
        hintNext:
          "Inline 'description' in the NDJSON line; --description-file is single-mode only.",
      },
    );
  }
  const input: CreateTaskInput = { name: line.name };
  if (line.worker !== undefined) input.worker = line.worker;
  if (line.due !== undefined) input.due = line.due;
  if (line.priority !== undefined) input.priority = line.priority;
  if (line.label !== undefined && line.label.length > 0) input.labels = line.label;
  if (line.description !== undefined) input.description = line.description;
  return input;
}

/**
 * Collapse repeated `--worker` values into the single id we send on the wire,
 * plus a `notice` flag for the envelope.
 *
 * Decision 4: only the first id is sent; a notice records the discarded ids.
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
    notice: `--worker repeated; only the first id was used. Discarded: ${rest.join(', ')}. R10 will let you change assignment after creation.`,
  };
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerCreate(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = tasks
    .command('create')
    .description('Create a task in a tasklist (single or NDJSON batch via --stdin).')
    .option('--tasklist <id>', 'Target tasklist id (numeric). Required.', (raw) =>
      parsePositiveIntFlag(
        '--tasklist',
        '--tasklist takes the numeric tasklist id from `freelo tasklists list`.',
        raw,
      ),
    )
    .option('--name <str>', 'Task name (required in single mode).')
    .option(
      '--worker <id>',
      'Worker user id (numeric). Repeatable; only the first id is sent (see envelope notice).',
      collectPositiveInt('--worker'),
    )
    .option('--due <date>', 'Due date (YYYY-MM-DD).', (raw) => parseDateFlag('--due', raw))
    .option('--priority <level>', 'Priority: low, normal, or high.', parsePriority)
    .option(
      '--label <name>',
      'Label name (repeatable). Each name is sent as a TaskLabelAddInput.',
      collectNonEmptyString('--label'),
    )
    .option('--description <text>', 'Inline task description (mutex with --description-file).')
    .option(
      '--description-file <path>',
      'Read task description from this UTF-8 file (mutex with --description). Single-mode only.',
    )
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.')
    .option('--stdin', 'Batch mode: read NDJSON from stdin (one task per line).')
    .option(
      '--project <id>',
      'Project id (only allowed with --dry-run; skips the tasklist→project lookup).',
      (raw) =>
        parsePositiveIntFlag(
          '--project',
          '--project is only valid with --dry-run; otherwise the project id is derived from --tasklist.',
          raw,
        ),
    );
  attachMeta(cmd, meta);

  cmd.action(async (opts: CreateOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      validateFlags(opts);

      if (opts.stdin === true) {
        await runBatch(opts, appConfig, env);
        return;
      }
      await runSingle(opts, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Flag validation (single + batch shared rules)
 * ------------------------------------------------------------------------- */

function validateFlags(opts: CreateOpts): void {
  if (opts.tasklist === undefined) {
    throw new ValidationError('--tasklist is required.', {
      hintNext: '--tasklist takes the numeric tasklist id from `freelo tasklists list`.',
    });
  }
  if (opts.project !== undefined && opts.dryRun !== true) {
    throw new ValidationError('--project is only valid with --dry-run.', {
      hintNext:
        'Drop --project; the project id is derived from --tasklist. Or add --dry-run to skip the lookup.',
    });
  }
  if (opts.description !== undefined && opts.descriptionFile !== undefined) {
    throw new ValidationError('Pass either --description or --description-file, not both.', {
      hintNext: 'Pick one source for the task description.',
    });
  }
  if (opts.stdin === true) {
    if (opts.name !== undefined) {
      throw new ValidationError('--name belongs to single mode.', {
        hintNext: 'In --stdin batch mode, put per-line names in NDJSON lines.',
      });
    }
    if (opts.descriptionFile !== undefined) {
      throw new ValidationError('--description-file is single-mode only.', {
        hintNext: "Inline 'description' in the NDJSON line.",
      });
    }
  } else {
    if (opts.name === undefined || opts.name.length === 0) {
      throw new ValidationError('--name is required.', {
        hintNext: '--name takes a non-empty task title, or use --stdin for batch input.',
      });
    }
  }
}

/* ---------------------------------------------------------------------------
 *  Single mode
 * ------------------------------------------------------------------------- */

async function runSingle(
  opts: CreateOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const tasklistId = opts.tasklist!;
  const mode = appConfig.output.mode;

  // Read --description-file if set. Single mode only.
  let description = opts.description;
  if (opts.descriptionFile !== undefined) {
    description = await readDescriptionFile(opts.descriptionFile);
  }

  const { workerId, notice: workerNotice } = pickWorkerWithNotice(opts.worker);

  const input: CreateTaskInput = { name: opts.name! };
  if (opts.due !== undefined) input.due = opts.due;
  if (workerId !== undefined) input.worker = workerId;
  if (opts.priority !== undefined) input.priority = opts.priority;
  if (opts.label !== undefined && opts.label.length > 0) input.labels = opts.label;
  if (description !== undefined && description.length > 0) input.description = description;

  const body = buildCreateTaskBody(input);

  // --- Dry-run with --project escape hatch: no HTTP at all.
  if (opts.dryRun === true && opts.project !== undefined) {
    const data: TasksCreateData = {
      tasklist_id: tasklistId,
      project_id: opts.project,
    };
    const envelope = dryRunEnvelope({
      schema: SCHEMA,
      data,
      would: { method: 'POST', path: createTaskPath(opts.project, tasklistId), body },
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      ...(workerNotice !== undefined ? { notice: workerNotice } : {}),
    });
    writeEnvelope(envelope, mode);
    return;
  }

  // Otherwise we need an HTTP client (for the lookup at minimum).
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

  // 1. Tasklist → project lookup.
  const projectId = await lookupProjectId(client, tasklistId, appConfig);

  // --- Dry-run without --project: lookup ran, but no POST.
  if (opts.dryRun === true) {
    const data: TasksCreateData = {
      tasklist_id: tasklistId,
      project_id: projectId,
    };
    const envelope = dryRunEnvelope({
      schema: SCHEMA,
      data,
      would: { method: 'POST', path: createTaskPath(projectId, tasklistId), body },
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      ...(workerNotice !== undefined ? { notice: workerNotice } : {}),
    });
    writeEnvelope(envelope, mode);
    return;
  }

  // 2. Live POST.
  const created = await createTask(client, {
    projectId,
    tasklistId,
    body,
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });

  const data: TasksCreateData = {
    task: created.task,
    tasklist_id: tasklistId,
    project_id: projectId,
  };
  const envelope = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: created.raw.rateLimit.remaining,
      reset_at: created.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    ...(workerNotice !== undefined ? { notice: workerNotice } : {}),
  });
  writeEnvelope(envelope, mode);
}

/* ---------------------------------------------------------------------------
 *  Batch mode (--stdin NDJSON in → NDJSON out)
 * ------------------------------------------------------------------------- */

async function runBatch(
  opts: CreateOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const tasklistId = opts.tasklist!;
  const mode = appConfig.output.mode;

  // --- Dry-run + --project: no HTTP at startup either.
  let projectIdMaybe: number | undefined;
  let client: HttpClient | undefined;

  if (opts.dryRun === true && opts.project !== undefined) {
    projectIdMaybe = opts.project;
  } else {
    // We need a client whether for the startup lookup or per-line POSTs.
    const creds = await resolveCredentials({
      profile: appConfig.profile,
      apiBaseUrl: appConfig.apiBaseUrl,
      env,
    });
    client = createHttpClient({
      email: creds.email,
      apiKey: creds.apiKey,
      apiBaseUrl: creds.apiBaseUrl,
      userAgent: appConfig.userAgent,
    });
    // Tasklist lookup once per batch — startup-time, a failure here aborts
    // the run before any line is read. This matches §3.5 — startup-time
    // errors emit a single error envelope and exit 1, no NDJSON stream.
    projectIdMaybe = await lookupProjectId(client, tasklistId, appConfig);
  }
  const projectId = projectIdMaybe;

  const exitAcc = new ExitCodeAccumulator();
  const stdinSource: NodeJS.ReadableStream = process.stdin;

  // Buffer stdin fully before processing — avoids any duplicate-iteration
  // edge cases with chunked stdin handling. NDJSON batches are line-oriented
  // and almost always small enough that buffering is fine; if we ever need
  // streaming for very large inputs, swap this for the chunked
  // `iterateLines(stdinSource)` form.
  const allLines: string[] = [];
  for await (const line of iterateLines(stdinSource)) {
    allLines.push(line);
  }

  let lineIndex = 0;
  for (const line of allLines) {
    const result = parseNdjsonLine(line, lineIndex, BatchLineSchema);
    if (!result.ok) {
      writeBatchError(result.error, lineIndex, mode);
      exitAcc.observe(result.error.exitCode);
      lineIndex += 1;
      continue;
    }
    try {
      const input = batchLineToInput(result.value, lineIndex);
      const body = buildCreateTaskBody(input);

      if (opts.dryRun === true) {
        const data: TasksCreateData = {
          tasklist_id: tasklistId,
          project_id: projectId,
          line_index: lineIndex,
        };
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data,
          would: { method: 'POST', path: createTaskPath(projectId, tasklistId), body },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        writeEnvelope(envelope, mode);
      } else {
        // client must be defined here (it's only undefined in dry-run+--project,
        // which is handled above). Defensive guard for the type system.
        if (client === undefined) {
          throw new ValidationError('Internal error: HTTP client unavailable in live batch.', {
            hintNext: 'Report this as a bug.',
          });
        }
        const created: CreateTaskResult = await createTask(client, {
          projectId,
          tasklistId,
          body,
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        emitBatchSuccess(
          created.task,
          tasklistId,
          projectId,
          lineIndex,
          {
            remaining: created.raw.rateLimit.remaining,
            reset_at: created.raw.rateLimit.resetAt,
          },
          mode,
          appConfig,
        );
      }
    } catch (err: unknown) {
      const typed = toBaseError(err, lineIndex);
      writeBatchError(typed, lineIndex, mode);
      exitAcc.observe(typed.exitCode);
    }
    lineIndex += 1;
  }

  if (exitAcc.value !== 0) {
    // Use handleTopLevelError style — but we've already emitted per-line
    // envelopes, so we just call exitDeferred via process.exit.
    // We can't import exitDeferred without making this an async-throw path;
    // instead, throw a no-op error with the accumulated exit code so the
    // outer `try/catch { handleTopLevelError(...) }` exits cleanly. Wait —
    // that would emit a SECOND error envelope. Better: directly call
    // process.exit through the error handler chain by throwing a sentinel
    // that handleTopLevelError treats as "already-emitted".
    //
    // Simpler approach: call `process.exit(value)` directly. The drain
    // happens in the SIGINT path; for normal batch exit we accept the
    // sub-millisecond drain skip on Linux/macOS and rely on the deferred
    // exit on Windows. We import drainDispatcher + exitDeferred locally.
    const { drainDispatcher, exitDeferred } = await import('../../errors/handle.js');
    await drainDispatcher();
    await exitDeferred(exitAcc.value);
  }
}

/* ---------------------------------------------------------------------------
 *  Helpers
 * ------------------------------------------------------------------------- */

async function readDescriptionFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`Failed to read --description-file: ${detail}`, {
      hintNext: 'Check the path is readable; UTF-8 expected.',
    });
  }
}

async function lookupProjectId(
  client: HttpClient,
  tasklistId: number,
  appConfig: PartialAppConfig,
): Promise<number> {
  const detail = await getTasklistDetail(client, tasklistId, {
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  return detail.data.project_id;
}

function writeEnvelope(envelope: unknown, mode: 'human' | 'json' | 'ndjson'): void {
  if (mode === 'human') {
    const env = envelope as { data: TasksCreateData; dry_run?: true };
    const line = renderTasksCreateHuman(env.data);
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function emitBatchSuccess(
  task: TaskCreated,
  tasklistId: number,
  projectId: number,
  lineIndex: number,
  rateLimit: { remaining: number | null; reset_at: string | null },
  mode: 'human' | 'json' | 'ndjson',
  appConfig: PartialAppConfig,
): void {
  const data: TasksCreateData = {
    task,
    tasklist_id: tasklistId,
    project_id: projectId,
    line_index: lineIndex,
  };
  const envelope = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit,
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  if (mode === 'human') {
    process.stdout.write(`${renderBatchLineSuccessHuman(data)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function writeBatchError(
  err: BaseError,
  lineIndex: number,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    process.stdout.write(`${renderBatchLineFailureHuman(lineIndex, err.message)}\n`);
    return;
  }
  // Build a freelo.error/v1 envelope augmented with `context.line_index`.
  const httpStatus =
    'httpStatus' in err && typeof err.httpStatus === 'number' ? err.httpStatus : null;
  const requestId = 'requestId' in err && typeof err.requestId === 'string' ? err.requestId : null;
  const errors =
    'errors' in err && Array.isArray((err as { errors?: unknown }).errors)
      ? (err as { errors: string[] }).errors
      : undefined;
  const envelope = {
    schema: 'freelo.error/v1' as const,
    error: {
      code: err.code,
      message: err.message,
      ...(errors !== undefined && errors.length > 0 ? { errors } : {}),
      http_status: httpStatus,
      request_id: requestId,
      retryable: err.retryable,
      hint_next: err.hintNext ?? null,
      docs_url: null,
      context: { line_index: lineIndex },
    },
  };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Coerce an unknown thrown value into a `BaseError`. Used inside the batch
 * loop where any line failure is per-line — the rest of the stream continues.
 *
 * Calibration §4: this is one of the new try/catch arms; covered by tests
 * (validation case, HTTP case, network case).
 */
function toBaseError(err: unknown, lineIndex: number): BaseError {
  if (err instanceof BaseError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ValidationError(`Line ${lineIndex + 1}: ${message}`, {
    hintNext: 'Investigate the underlying error and retry the line.',
  });
}
