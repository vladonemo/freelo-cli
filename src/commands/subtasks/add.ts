/**
 * `freelo subtasks add --task <id> --name <str> [...]` (R14, spec 0025).
 *
 * Creates a subtask under the given parent task. The Freelo API auto-falls-
 * back from a **smart taskcheck** (full task with worker, due date, tracking
 * users) to a **simple taskcheck** (a checkbox row with only a name) when
 * the parent's tasklist can't host smart ones — OpenAPI :2425. The CLI
 * surfaces the resulting form via `data.storage_form` and lists discarded
 * inputs via `data.input_ignored[]`.
 *
 * Output schema: `freelo.subtasks.add/v1`.
 *
 * Surfaces:
 *   - Single mode: `subtasks add --task <id> --name <str> [--worker <id>] [--due YYYY-MM-DD] [--dry-run]`.
 *   - Batch (`--stdin`): NDJSON `{ "name": ..., "worker"?: ..., "due"?: ... }` per line.
 *
 * Spec 0025 §3.3.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  buildCreateSubtaskBody,
  createSubtask,
  createSubtaskPath,
  inferStorageForm,
  type CreateSubtaskResult,
} from '../../api/subtasks.js';
import {
  type CreateSubtaskInput,
  type SubtasksAddData,
  type SubtaskIgnoredInput,
} from '../../api/schemas/subtask.js';
import { type Subtask } from '../../api/schemas/task.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import {
  renderSubtasksAddHuman,
  renderSubtasksAddBatchLineSuccessHuman,
  renderSubtasksAddBatchLineFailureHuman,
} from '../../ui/human/subtasks-add.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.subtasks.add/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.subtasks.add/v1';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type AddOpts = {
  task?: number;
  name?: string;
  worker?: number;
  due?: string;
  dryRun?: boolean;
  stdin?: boolean;
};

/* ---------------------------------------------------------------------------
 *  Per-line NDJSON schema (--stdin batch mode). Mirrors R09's BatchLineSchema.
 *  `task` is reserved here so `.strict()` doesn't reject it via a generic
 *  message — the command-level validator emits a precise error.
 * ------------------------------------------------------------------------- */

const BatchLineSchema = z
  .object({
    name: z.string().min(1, "'name' must be a non-empty string"),
    worker: z.number().int().positive().optional(),
    due: z.string().regex(ISO_DATE, "'due' must be in YYYY-MM-DD format").optional(),
    // Reserved key — present so `.strict()` does NOT reject it; the
    // command-level validator below emits a more precise error.
    task: z.unknown().optional(),
  })
  .strict();

type BatchLine = z.infer<typeof BatchLineSchema>;

/* ---------------------------------------------------------------------------
 *  Flag parsers
 * ------------------------------------------------------------------------- */

function parsePositiveIntFlag(label: string, hint: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`${label} must be a positive integer.`, { hintNext: hint });
  }
  return n;
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

/**
 * Map one parsed NDJSON line to a `CreateSubtaskInput`. Catches the reserved
 * `task` key (decision: per-line `task` is forbidden because `--task` is
 * shared per-batch on the command line — mirrors R09's per-line `tasklist`
 * rejection, spec 0019 decision 6).
 */
function batchLineToInput(line: BatchLine, lineIndex: number): CreateSubtaskInput {
  if (line.task !== undefined) {
    throw new ValidationError(`Line ${lineIndex + 1}: per-line 'task' is not allowed.`, {
      hintNext: 'Pass --task on the command line, not in NDJSON lines.',
    });
  }
  const input: CreateSubtaskInput = { name: line.name };
  if (line.worker !== undefined) input.worker = line.worker;
  if (line.due !== undefined) input.due = line.due;
  return input;
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerAdd(
  subtasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  // Description includes the smart-vs-simple paragraph so it surfaces in
  // `freelo subtasks add --help`. Roadmap-mandated UX requirement.
  const description =
    'Create a subtask (taskcheck) under a parent task (single or NDJSON batch via --stdin). ' +
    "Note: Freelo's API auto-falls-back from a smart subtask (full task with worker, due date, etc.) " +
    "to a simple taskcheck (a checkbox row with only a name) when the parent's tasklist " +
    "can't host smart ones. The response envelope's `data.storage_form` field reflects " +
    'which form was actually persisted; `data.input_ignored[]` lists fields you set that ' +
    'the server discarded on the simple path.';

  const cmd = subtasks
    .command('add')
    .description(description)
    .option('--task <id>', 'Parent task id (required, positive integer).', (raw) =>
      parsePositiveIntFlag(
        '--task',
        '--task takes the numeric parent-task id from `freelo tasks list`.',
        raw,
      ),
    )
    .option('--name <str>', 'Subtask title (required in single mode; forbidden with --stdin).')
    .option('--worker <id>', 'Worker user id (numeric).', (raw) =>
      parsePositiveIntFlag(
        '--worker',
        '--worker takes the numeric user id from `freelo users list`.',
        raw,
      ),
    )
    .option('--due <date>', 'Due date (YYYY-MM-DD).', (raw) => parseDateFlag('--due', raw))
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.')
    .option('--stdin', 'Batch mode: read NDJSON from stdin (one subtask per line).');
  attachMeta(cmd, meta);

  cmd.action(async (opts: AddOpts) => {
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

function validateFlags(opts: AddOpts): void {
  // --task is required by Commander's `requiredOption`, but defensive guard
  // for tests that drive the action directly.
  if (opts.task === undefined) {
    throw new ValidationError('--task is required.', {
      hintNext: '--task takes the numeric parent-task id from `freelo tasks list`.',
    });
  }
  if (opts.stdin === true) {
    if (opts.name !== undefined) {
      throw new ValidationError('--name belongs to single mode.', {
        hintNext: 'In --stdin batch mode, put per-line names in NDJSON lines.',
      });
    }
    if (opts.worker !== undefined) {
      throw new ValidationError('--worker is single-mode only.', {
        hintNext: "Inline 'worker' in the NDJSON line.",
      });
    }
    if (opts.due !== undefined) {
      throw new ValidationError('--due is single-mode only.', {
        hintNext: "Inline 'due' in the NDJSON line.",
      });
    }
  } else {
    if (opts.name === undefined || opts.name.length === 0) {
      throw new ValidationError('--name is required.', {
        hintNext: '--name takes a non-empty subtask title, or use --stdin for batch input.',
      });
    }
  }
}

/* ---------------------------------------------------------------------------
 *  Single mode
 * ------------------------------------------------------------------------- */

async function runSingle(
  opts: AddOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const taskId = opts.task!;
  const mode = appConfig.output.mode;

  const input: CreateSubtaskInput = { name: opts.name! };
  if (opts.due !== undefined) input.due = opts.due;
  if (opts.worker !== undefined) input.worker = opts.worker;
  const body = buildCreateSubtaskBody(input);

  // --- Dry-run: no HTTP, no credential resolution.
  if (opts.dryRun === true) {
    const data: SubtasksAddData = {
      task_id: taskId,
    };
    const envelope = dryRunEnvelope({
      schema: SCHEMA,
      data,
      would: { method: 'POST', path: createSubtaskPath(taskId), body },
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    writeEnvelope(envelope, mode);
    return;
  }

  // --- Live POST.
  const client = await buildClient(appConfig, env);

  let result: CreateSubtaskResult;
  try {
    result = await createSubtask(client, {
      taskId,
      body,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    throw rewriteAddHint(err, taskId);
  }

  const data = buildAddDataFromResponse(taskId, result.subtask, input);
  const envelope = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: result.raw.rateLimit.remaining,
      reset_at: result.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  writeEnvelope(envelope, mode);
}

/* ---------------------------------------------------------------------------
 *  Batch mode (--stdin NDJSON in → NDJSON out)
 * ------------------------------------------------------------------------- */

async function runBatch(
  opts: AddOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const taskId = opts.task!;
  const mode = appConfig.output.mode;
  const exitAcc = new ExitCodeAccumulator();

  const stdinSource: NodeJS.ReadableStream = process.stdin;
  // Buffer fully — mirrors R09's batch flow (NDJSON inputs are line-oriented
  // and small enough that buffering is fine).
  const allLines: string[] = [];
  for await (const line of iterateLines(stdinSource)) {
    allLines.push(line);
  }
  if (allLines.length === 0) {
    // Empty stdin → silent success (matches R09 / R11 / R12.5 / R13).
    return;
  }

  // Lazy client construction — a stdin of all-bad lines never reaches
  // credential resolution.
  let lazyClient: HttpClient | undefined;
  const getClient = async (): Promise<HttpClient> => {
    if (lazyClient === undefined) {
      lazyClient = await buildClient(appConfig, env);
    }
    return lazyClient;
  };

  for (let i = 0; i < allLines.length; i += 1) {
    const line = allLines[i]!;
    const result = parseNdjsonLine(line, i, BatchLineSchema);
    if (!result.ok) {
      writeBatchError(result.error, i, mode);
      exitAcc.observe(result.error.exitCode);
      continue;
    }
    try {
      const input = batchLineToInput(result.value, i);
      const body = buildCreateSubtaskBody(input);

      if (opts.dryRun === true) {
        const data: SubtasksAddData = {
          task_id: taskId,
          line_index: i,
        };
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data,
          would: { method: 'POST', path: createSubtaskPath(taskId), body },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        writeBatchEnvelope(envelope, mode);
      } else {
        const client = await getClient();
        let resp: CreateSubtaskResult;
        try {
          resp = await createSubtask(client, {
            taskId,
            body,
            ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
          });
        } catch (err: unknown) {
          throw rewriteAddHint(err, taskId);
        }
        const data = buildAddDataFromResponse(taskId, resp.subtask, input);
        data.line_index = i;
        const envelope = buildEnvelope({
          schema: SCHEMA,
          data,
          rateLimit: {
            remaining: resp.raw.rateLimit.remaining,
            reset_at: resp.raw.rateLimit.resetAt,
          },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        writeBatchEnvelope(envelope, mode);
      }
    } catch (err: unknown) {
      const typed = toBaseError(err, i);
      writeBatchError(typed, i, mode);
      exitAcc.observe(typed.exitCode);
    }
  }

  if (exitAcc.value !== 0) {
    const { drainDispatcher, exitDeferred } = await import('../../errors/handle.js');
    await drainDispatcher();
    await exitDeferred(exitAcc.value);
  }
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
 * Build the `freelo.subtasks.add/v1` `data` payload from a successful POST
 * response. Computes `storage_form` via `inferStorageForm` and `input_ignored`
 * by comparing the user's CLI input against the resolved storage form.
 *
 * Spec 0025 §4.4 / §4.5.
 */
function buildAddDataFromResponse(
  taskId: number,
  subtask: Subtask,
  input: CreateSubtaskInput,
): SubtasksAddData {
  const storageForm = inferStorageForm(subtask);

  const data: SubtasksAddData = {
    task_id: taskId,
    subtask,
    storage_form: storageForm,
  };

  if (storageForm === 'simple') {
    const ignored: SubtaskIgnoredInput[] = [];
    if (input.worker !== undefined) ignored.push('worker');
    if (input.due !== undefined) ignored.push('due');
    if (ignored.length > 0) data.input_ignored = ignored;
  }

  return data;
}

function writeEnvelope(
  envelope: Envelope<SubtasksAddData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    process.stdout.write(`${renderSubtasksAddHuman(envelope.data)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function writeBatchEnvelope(
  envelope: Envelope<SubtasksAddData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    process.stdout.write(`${renderSubtasksAddBatchLineSuccessHuman(envelope.data)}\n`);
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
    process.stdout.write(`${renderSubtasksAddBatchLineFailureHuman(lineIndex, err.message)}\n`);
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
 * Hint rewriter for `createSubtask` failures. Mirrors R08's
 * `rewriteDetailHint`: 404 (parent task missing) and 403 (no access) get
 * resource-specific copy. Other statuses pass through unchanged.
 */
function rewriteAddHint(err: unknown, taskId: number): unknown {
  if (!(err instanceof FreeloApiError) || (err.httpStatus !== 404 && err.httpStatus !== 403)) {
    return err;
  }
  const hintNext =
    err.httpStatus === 404
      ? `Task ${taskId} not found, or your account does not have access to it.`
      : `Account does not have permission to add subtasks to task ${taskId}.`;
  return new FreeloApiError(err.message, err.code, {
    httpStatus: err.httpStatus,
    errors: err.errors,
    rawBody: err.rawBody,
    hintNext,
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
  });
}

/**
 * Coerce an unknown thrown value into a `BaseError`. Used inside the batch
 * loop where any line failure is per-line. Mirrors R09's `toBaseError`.
 *
 * Calibration §4: this is one of the new try/catch arms; covered by tests.
 */
function toBaseError(err: unknown, lineIndex: number): BaseError {
  if (err instanceof BaseError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ValidationError(`Line ${lineIndex + 1}: ${message}`, {
    hintNext: 'Investigate the underlying error and retry the line.',
  });
}
