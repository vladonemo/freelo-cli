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
import { addTaskLabels } from '../../api/tasks-edit.js';
import {
  type AppliedLabelFailure,
  type CreateTaskInput,
  type CreateWouldEntry,
  type TaskCreated,
  type TasksCreateData,
} from '../../api/schemas/task.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
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
  outputSchema: 'freelo.tasks.create/v2',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.tasks.create/v2';

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
      'Label name (repeatable). Sent as a single batched POST /task-labels/add-to-task/<new-id> after the task is created. On attach failure the task is still created; see applied_labels.failed for diagnosis.',
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
  const requestedLabels: readonly string[] = input.labels ?? [];

  // --- Dry-run with --project escape hatch: no HTTP at all.
  if (opts.dryRun === true && opts.project !== undefined) {
    const data: TasksCreateData = {
      tasklist_id: tasklistId,
      project_id: opts.project,
      would: buildDryRunWould(opts.project, tasklistId, body, requestedLabels),
    };
    writeDryRunEnvelope(data, mode, appConfig, workerNotice);
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
      would: buildDryRunWould(projectId, tasklistId, body, requestedLabels),
    };
    writeDryRunEnvelope(data, mode, appConfig, workerNotice);
    return;
  }

  // 2. Live POST — create the task without labels (spec 0041 §5.1).
  const created = await createTask(client, {
    projectId,
    tasklistId,
    body,
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });

  // 3. Live attach — only when labels were requested.
  let appliedLabels: TasksCreateData['applied_labels'];
  let attachNotice: string | undefined;
  let attachError: BaseError | undefined;
  let lastRateLimit = created.raw.rateLimit;

  if (requestedLabels.length > 0) {
    try {
      const result = await addTaskLabels(client, created.task.id, requestedLabels, {
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      if (result.raw !== null) lastRateLimit = result.raw.rateLimit;
      appliedLabels = {
        requested: [...requestedLabels],
        attached: [...result.names],
        failed: [],
      };
    } catch (err: unknown) {
      // Calibration §4: this catch arm is exercised by the partial-failure
      // tests in `test/commands/tasks/create.test.ts` (attach 422, attach 502,
      // attach network).
      const typed = toAttachError(err);
      attachError = typed;
      appliedLabels = {
        requested: [...requestedLabels],
        attached: [],
        failed: requestedLabels.map((name) => attachFailure(name, typed)),
      };
      attachNotice = `Task created but label attach failed; task #${created.task.id} has no labels.`;
    }
  }

  const data: TasksCreateData = {
    task: created.task,
    tasklist_id: tasklistId,
    project_id: projectId,
    ...(appliedLabels !== undefined ? { applied_labels: appliedLabels } : {}),
  };
  // Compose the success-line notice. If both worker notice AND attach notice
  // exist, concatenate them — agents read `notice` as a single human string.
  const notices: string[] = [];
  if (workerNotice !== undefined) notices.push(workerNotice);
  if (attachNotice !== undefined) notices.push(attachNotice);
  const noticeOpt = notices.length > 0 ? notices.join(' ') : undefined;

  const envelope = buildEnvelope({
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

  // Dual emit: stdout already carries the success-shaped envelope (so agents
  // can read `data.task.id`); stderr now carries the attach diagnostic and we
  // exit with the attach error's exit code (4 for FreeloApiError, 5 for
  // NetworkError, 6 for RateLimitedError). Spec 0041 §7.2.
  if (attachError !== undefined) {
    writeStderrErrorEnvelope(
      attachError,
      { task_id: created.task.id, requested_label_names: [...requestedLabels] },
      mode,
    );
    const { drainDispatcher, exitDeferred } = await import('../../errors/handle.js');
    await drainDispatcher();
    await exitDeferred(attachError.exitCode);
  }
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
      const requestedLabels: readonly string[] = input.labels ?? [];

      if (opts.dryRun === true) {
        const data: TasksCreateData = {
          tasklist_id: tasklistId,
          project_id: projectId,
          line_index: lineIndex,
          would: buildDryRunWould(projectId, tasklistId, body, requestedLabels),
        };
        writeDryRunEnvelope(data, mode, appConfig, undefined);
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

        // Per-line label attach (spec 0041 §7.3). Failure here is per-line: we
        // emit the success-shaped envelope (with `applied_labels.failed`) and a
        // SECOND NDJSON line carrying the error envelope; the stream continues.
        let appliedLabels: TasksCreateData['applied_labels'];
        let attachNotice: string | undefined;
        let attachErr: BaseError | undefined;
        let lineRateLimit = created.raw.rateLimit;

        if (requestedLabels.length > 0) {
          try {
            const attachRes = await addTaskLabels(client, created.task.id, requestedLabels, {
              ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
            });
            if (attachRes.raw !== null) lineRateLimit = attachRes.raw.rateLimit;
            appliedLabels = {
              requested: [...requestedLabels],
              attached: [...attachRes.names],
              failed: [],
            };
          } catch (attachThrow: unknown) {
            // Calibration §4: per-line attach catch — covered by the batch
            // partial-failure test in `test/commands/tasks/create.test.ts`.
            const typed = toAttachError(attachThrow);
            attachErr = typed;
            appliedLabels = {
              requested: [...requestedLabels],
              attached: [],
              failed: requestedLabels.map((name) => attachFailure(name, typed)),
            };
            attachNotice = `Task created but label attach failed; task #${created.task.id} has no labels.`;
          }
        }

        emitBatchSuccess(
          created.task,
          tasklistId,
          projectId,
          lineIndex,
          {
            remaining: lineRateLimit.remaining,
            reset_at: lineRateLimit.resetAt,
          },
          mode,
          appConfig,
          appliedLabels,
          attachNotice,
        );

        if (attachErr !== undefined) {
          // Per-line dual emit: write the error envelope on stdout (NDJSON
          // stream is the single output channel — spec 0041 §7.3) tagged with
          // `line_index` so consumers can correlate.
          writeBatchError(attachErr, lineIndex, mode, {
            task_id: created.task.id,
            requested_label_names: [...requestedLabels],
          });
          exitAcc.observe(attachErr.exitCode);
        }
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

function writeEnvelope(
  envelope: Envelope<TasksCreateData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const line = renderTasksCreateHuman(envelope.data);
    process.stdout.write(`${line}\n`);
    if (envelope.notice !== undefined) {
      process.stdout.write(`Notice: ${envelope.notice}\n`);
    }
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Build a `--dry-run` envelope inline. R09 (after spec 0041) emits an array
 * `data.would`, mirroring R10's pattern; the shared `dryRunEnvelope` helper
 * still assumes a single object and is used by R11/R12/R13 unchanged. Spec
 * 0041 §6.1.
 */
function writeDryRunEnvelope(
  data: TasksCreateData,
  mode: 'human' | 'json' | 'ndjson',
  appConfig: PartialAppConfig,
  workerNotice: string | undefined,
): void {
  const envelope: Envelope<TasksCreateData> = {
    schema: SCHEMA,
    data,
    dry_run: true,
  };
  if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
  if (workerNotice !== undefined) envelope.notice = workerNotice;
  writeEnvelope(envelope, mode);
}

/**
 * Build the array-shaped `data.would` for `--dry-run`. First entry is always
 * the create call; second entry (only when labels were requested) is the
 * follow-up attach call with `{new_task_id}` as a placeholder — the real id
 * isn't known until the create returns.
 *
 * Spec 0041 §4.3.
 */
function buildDryRunWould(
  projectId: number,
  tasklistId: number,
  body: ReturnType<typeof buildCreateTaskBody>,
  labels: readonly string[],
): CreateWouldEntry[] {
  const list: CreateWouldEntry[] = [
    { method: 'POST', path: createTaskPath(projectId, tasklistId), body },
  ];
  if (labels.length > 0) {
    // The new task id isn't known until the create call returns, so the path
    // carries `{new_task_id}` as a placeholder. Documented in help text and
    // in `docs/commands/tasks-create.md`. Spec 0041 §4.3.
    list.push({
      method: 'POST',
      path: `/task-labels/add-to-task/{new_task_id}`,
      body: { labels: labels.map((name) => ({ name })) },
    });
  }
  return list;
}

function emitBatchSuccess(
  task: TaskCreated,
  tasklistId: number,
  projectId: number,
  lineIndex: number,
  rateLimit: { remaining: number | null; reset_at: string | null },
  mode: 'human' | 'json' | 'ndjson',
  appConfig: PartialAppConfig,
  appliedLabels: TasksCreateData['applied_labels'],
  attachNotice: string | undefined,
): void {
  const data: TasksCreateData = {
    task,
    tasklist_id: tasklistId,
    project_id: projectId,
    line_index: lineIndex,
    ...(appliedLabels !== undefined ? { applied_labels: appliedLabels } : {}),
  };
  const envelope = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit,
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    ...(attachNotice !== undefined ? { notice: attachNotice } : {}),
  });
  if (mode === 'human') {
    process.stdout.write(`${renderBatchLineSuccessHuman(data)}\n`);
    if (envelope.notice !== undefined) {
      process.stdout.write(`Notice: ${envelope.notice}\n`);
    }
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function writeBatchError(
  err: BaseError,
  lineIndex: number,
  mode: 'human' | 'json' | 'ndjson',
  extraContext?: Record<string, unknown>,
): void {
  if (mode === 'human') {
    process.stdout.write(`${renderBatchLineFailureHuman(lineIndex, err.message)}\n`);
    return;
  }
  // Build a freelo.error/v1 envelope augmented with `context.line_index` and
  // any additional context (e.g. task_id + requested_label_names for per-line
  // attach failures — spec 0041 §7.3).
  const httpStatus =
    'httpStatus' in err && typeof err.httpStatus === 'number' ? err.httpStatus : null;
  const requestId = 'requestId' in err && typeof err.requestId === 'string' ? err.requestId : null;
  const errors =
    'errors' in err && Array.isArray((err as { errors?: unknown }).errors)
      ? (err as { errors: string[] }).errors
      : undefined;
  const context: Record<string, unknown> = { line_index: lineIndex };
  if (extraContext !== undefined) {
    Object.assign(context, extraContext);
  }
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
      context,
    },
  };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Write a `freelo.error/v1` envelope to stderr for the dual-emit path
 * (spec 0041 §7.2). Single-mode equivalent of `writeBatchError`'s NDJSON
 * branch — but lands on stderr because the success envelope already owns
 * stdout. In `human` mode, emits a one-line "freelo: …" message instead.
 */
function writeStderrErrorEnvelope(
  err: BaseError,
  context: Record<string, unknown>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    process.stderr.write(`freelo: ${err.message}\n`);
    if (err.hintNext) {
      process.stderr.write(`  hint: ${err.hintNext}\n`);
    }
    return;
  }
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
      context,
    },
  };
  process.stderr.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Coerce an unknown thrown value from the attach call into a `BaseError`.
 * Used inside the create-then-attach try/catch (single + batch). Same shape
 * as `toBaseError` but without the `Line N:` prefix — the attach call isn't
 * line-scoped semantically (the line context is tracked separately).
 */
function toAttachError(err: unknown): BaseError {
  if (err instanceof BaseError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ValidationError(`Label attach failed: ${message}`, {
    hintNext: 'Investigate the attach error and retry attaching labels.',
  });
}

/**
 * Build a per-name `AppliedLabelFailure` from a single root error. Called for
 * every requested name when the batched attach POST fails — the wire-level
 * failure is all-or-nothing (spec 0041 §6.2).
 */
function attachFailure(name: string, err: BaseError): AppliedLabelFailure {
  const httpStatus =
    'httpStatus' in err && typeof err.httpStatus === 'number' ? err.httpStatus : null;
  return {
    name,
    error_code: err.code,
    http_status: httpStatus,
    message: err.message,
  };
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
