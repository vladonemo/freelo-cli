/**
 * `freelo custom-fields value clear --task <id> --field <uuid> [--yes] [--dry-run]`
 * (R42, spec 0056).
 *
 * Clears a custom-field value on a task. Destructive — gates on the shared
 * `confirmDestructive` helper. Read-then-delete because the DELETE endpoint
 * takes a value-uuid (NOT a field-uuid):
 *
 *   1. `GET /task/{task_id}` → find `custom_fields[].field_uuid === <field>`.
 *   2. If none / no `value_uuid` → idempotent skip (already-absent).
 *   3. Else `DELETE /custom-field/delete-value/{value_uuid}` (yaml :4296-4324).
 *      On 404 → idempotent skip (race condition).
 *
 * Two-arm idempotency:
 *   1. read-back found nothing → already_in_target_state: true, exit 0
 *   2. DELETE returned 404      → already_in_target_state: true, exit 0
 *   Other non-2xx → bubble.
 *
 * Batch input: NDJSON via `--stdin` only. Per-line shape:
 *   `{ "task_id": <int>, "field_uuid": "<uuid>" }`
 *
 * Output schema: `freelo.custom-fields.value-clear/v1`.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../../config/schema.js';
import { resolveCredentials } from '../../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../../api/client.js';
import { getTaskDetail } from '../../../api/tasks.js';
import { deleteCustomFieldValue, deleteCustomFieldValuePath } from '../../../api/custom-fields.js';
import {
  CustomFieldWithValueSchema,
  type CustomFieldsValueClearData,
} from '../../../api/schemas/custom-field.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../../ui/envelope.js';
import { renderCustomFieldsValueClearHuman } from '../../../ui/human/custom-fields-value-clear.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../../lib/batch.js';
import { confirmDestructive } from '../../../lib/confirm.js';
import { handleTopLevelError } from '../../../errors/handle.js';
import { ValidationError } from '../../../errors/validation-error.js';
import { FreeloApiError } from '../../../errors/freelo-api-error.js';
import { BaseError } from '../../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.custom-fields.value-clear/v1',
  destructive: true,
};

const SCHEMA: SchemaString = 'freelo.custom-fields.value-clear/v1';

type ClearOpts = {
  task?: number;
  field?: string;
  stdin?: true;
  dryRun?: true;
};

type Job = {
  taskId: number;
  fieldUuid: string;
};

/* ---------------------------------------------------------------------------
 *  Per-line NDJSON schema. `value` / `enum` keys not allowed on clear lines.
 * ------------------------------------------------------------------------- */

const BatchLineSchema = z
  .object({
    task_id: z.number().int().positive("'task_id' must be ≥ 1."),
    field_uuid: z.string().min(1, "'field_uuid' must be a non-empty string."),
  })
  .strict();

/* ---------------------------------------------------------------------------
 *  Flag parsers
 * ------------------------------------------------------------------------- */

function parseTaskFlag(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--task must be a positive integer.', {
      hintNext: '--task is the numeric task id (e.g. from `freelo tasks list`).',
    });
  }
  return n;
}

function parseFieldFlag(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('--field must be a non-empty uuid.', {
      hintNext:
        '--field is a custom-field uuid. Run `freelo custom-fields list --project <id>` for ids.',
    });
  }
  return trimmed;
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerClear(
  value: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = value
    .command('clear')
    .description(
      'Clear a custom-field value on a task. Destructive — requires --yes (non-TTY) or interactive confirmation (TTY). Idempotent: returns success if no value is set. Use --stdin for NDJSON batch input.',
    )
    .option('--task <id>', 'Task id (positive integer).', parseTaskFlag)
    .option('--field <uuid>', 'Custom-field uuid.', parseFieldFlag)
    .option(
      '--stdin',
      'Read NDJSON from stdin (one `{"task_id","field_uuid"}` per line). Mutex with --task/--field.',
    )
    .option(
      '--dry-run',
      'Skip both the read-back and the DELETE. Envelope reflects what *would* have been called.',
    );
  attachMeta(cmd, meta);

  cmd.action(async (opts: ClearOpts, cmdCtx: Command) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;
    const yes = resolveYesFlag(cmdCtx);

    try {
      validateInputSources(opts);

      if (opts.stdin === true) {
        await runBatchFromStdin(opts, yes, appConfig, env);
        return;
      }

      const job = resolveJobFromFlags(opts);
      await runSingleJob(job, opts, yes, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

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
 *  Cross-source validation
 * ------------------------------------------------------------------------- */

function validateInputSources(opts: ClearOpts): void {
  const hasFlags = opts.task !== undefined || opts.field !== undefined;
  const hasStdin = opts.stdin === true;
  if (hasFlags && hasStdin) {
    throw new ValidationError('Pick exactly one input source: --task/--field or --stdin.', {
      hintNext: 'Combining input sources is ambiguous — agents should pre-resolve to one shape.',
    });
  }
  if (!hasFlags && !hasStdin) {
    throw new ValidationError('No input supplied.', {
      hintNext: 'Pass --task <id> --field <uuid>, or pipe NDJSON to --stdin.',
    });
  }
}

function resolveJobFromFlags(opts: ClearOpts): Job {
  if (opts.task === undefined) {
    throw new ValidationError('--task is required.', {
      hintNext: 'Pass --task <id> where <id> is the numeric task id.',
    });
  }
  if (opts.field === undefined) {
    throw new ValidationError('--field is required.', {
      hintNext:
        'Pass --field <uuid>. Run `freelo custom-fields list --project <id>` to discover field uuids.',
    });
  }
  return { taskId: opts.task, fieldUuid: opts.field };
}

/* ---------------------------------------------------------------------------
 *  Single-job (flag-driven) path. Flag input only ever produces one job — see
 *  `resolveJobFromFlags`. The positional-list batch path is removed because
 *  the CLI surface does not expose a way to pass multiple jobs via flags
 *  (each job carries multiple fields; that's what `--stdin` is for).
 * ------------------------------------------------------------------------- */

async function runSingleJob(
  job: Job,
  opts: ClearOpts,
  yes: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await confirmDestructive({
    promptMessage: confirmMessage(1),
    yes,
    dryRun: opts.dryRun === true,
  });

  const client = await buildClient(appConfig, env);
  await runOneJob(job, opts, appConfig, client, /* lineIndex */ undefined);
}

/* ---------------------------------------------------------------------------
 *  Batch from --stdin (NDJSON)
 * ------------------------------------------------------------------------- */

async function runBatchFromStdin(
  opts: ClearOpts,
  yes: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const exitAcc = new ExitCodeAccumulator();

  const stdinSource: NodeJS.ReadableStream = process.stdin;
  const allLines: string[] = [];
  for await (const line of iterateLines(stdinSource)) {
    allLines.push(line);
  }

  if (allLines.length === 0) return;

  await confirmDestructive({
    promptMessage: confirmMessage(allLines.length),
    yes,
    dryRun: opts.dryRun === true,
  });

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
      writeBatchError(result.error, i, /* taskIdMaybe */ null, mode);
      exitAcc.observe(result.error.exitCode);
      continue;
    }
    const job: Job = {
      taskId: result.value.task_id,
      fieldUuid: result.value.field_uuid,
    };
    try {
      const client = await getClient();
      await runOneJob(job, opts, appConfig, client, /* lineIndex */ i);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, job.taskId, mode);
      exitAcc.observe(typed.exitCode);
    }
  }

  if (exitAcc.value !== 0) {
    const { drainDispatcher, exitDeferred } = await import('../../../errors/handle.js');
    await drainDispatcher();
    await exitDeferred(exitAcc.value);
  }
}

/* ---------------------------------------------------------------------------
 *  Per-job flow — dry-run / read-back / DELETE / two-arm idempotency
 * ------------------------------------------------------------------------- */

async function runOneJob(
  job: Job,
  opts: ClearOpts,
  appConfig: PartialAppConfig,
  client: HttpClient,
  lineIndex: number | undefined,
): Promise<void> {
  const mode = appConfig.output.mode;

  // ---- 1. Dry-run — no read-back, no DELETE.
  if (opts.dryRun === true) {
    const data: CustomFieldsValueClearData = {
      task_id: job.taskId,
      field_uuid: job.fieldUuid,
      value_uuid: null,
      previous_state: 'set',
      current_state: 'absent',
      already_in_target_state: false,
      would: {
        method: 'DELETE',
        path: deleteCustomFieldValuePath('<would-be-resolved-from-task>'),
        body: {},
      },
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope: Envelope<CustomFieldsValueClearData> = {
      schema: SCHEMA,
      data,
      dry_run: true,
    };
    if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
    writeEnvelope(envelope, mode);
    return;
  }

  // ---- 2. Read-back to resolve value-uuid.
  let valueUuid: string | null;
  try {
    valueUuid = await resolveValueUuid(client, job, appConfig);
  } catch (err: unknown) {
    throw rewriteReadBackHint(err);
  }

  // ---- 3. Idempotency arm 1 — no value to clear.
  if (valueUuid === null) {
    const data: CustomFieldsValueClearData = {
      task_id: job.taskId,
      field_uuid: job.fieldUuid,
      value_uuid: null,
      previous_state: 'absent',
      current_state: 'absent',
      already_in_target_state: true,
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope = buildEnvelope({
      schema: SCHEMA,
      data,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    writeEnvelope(envelope, mode);
    return;
  }

  // ---- 4. Live DELETE.
  try {
    const result = await deleteCustomFieldValue(client, valueUuid, {
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    const data: CustomFieldsValueClearData = {
      task_id: job.taskId,
      field_uuid: job.fieldUuid,
      value_uuid: valueUuid,
      previous_state: 'set',
      current_state: 'absent',
      already_in_target_state: false,
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
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
  } catch (err: unknown) {
    // ---- 5. Idempotency arm 2 — DELETE 404 (race condition).
    if (err instanceof FreeloApiError && isIdempotentDeleteSkip(err)) {
      const data: CustomFieldsValueClearData = {
        task_id: job.taskId,
        field_uuid: job.fieldUuid,
        value_uuid: valueUuid,
        previous_state: 'set',
        current_state: 'absent',
        already_in_target_state: true,
        ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
      };
      const envelope = buildEnvelope({
        schema: SCHEMA,
        data,
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      writeEnvelope(envelope, mode);
      return;
    }
    throw rewriteDeleteHint(err);
  }
}

/**
 * Resolve `(taskId, fieldUuid) → valueUuid` via `GET /task/{task_id}`. Returns
 * `null` when:
 *
 *   - No `custom_fields[]` entry matches `field_uuid`.
 *   - The matching entry has no `value_uuid` (unlikely but defensive).
 *
 * Throws `FreeloApiError` on read-back failures (caller wraps with hint).
 */
async function resolveValueUuid(
  client: HttpClient,
  job: Job,
  appConfig: PartialAppConfig,
): Promise<string | null> {
  const raw = await getTaskDetail(client, job.taskId, {
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  const cfs = raw.data.custom_fields;
  if (!Array.isArray(cfs) || cfs.length === 0) return null;
  for (const item of cfs) {
    const parsed = CustomFieldWithValueSchema.safeParse(item);
    if (!parsed.success) continue;
    if (parsed.data.field_uuid === job.fieldUuid) {
      const vuid = parsed.data.value_uuid;
      if (typeof vuid === 'string' && vuid.length > 0) return vuid;
      return null;
    }
  }
  return null;
}

/**
 * Whether a DELETE failure is the idempotent-skip arm (404 → already cleared).
 * Exported for direct unit-test coverage of the matrix.
 */
export function isIdempotentDeleteSkip(err: FreeloApiError): boolean {
  return err.httpStatus === 404;
}

/* ---------------------------------------------------------------------------
 *  Hint rewrites
 * ------------------------------------------------------------------------- */

function rewriteReadBackHint(err: unknown): unknown {
  if (!(err instanceof FreeloApiError)) return err;
  if (err.httpStatus === 404) {
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: 'Task not found. Verify --task; run `freelo tasks list` for ids.',
    });
  }
  if (err.httpStatus === 403) {
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: 'Account cannot read this task — read-back required for value clear.',
    });
  }
  return err;
}

function rewriteDeleteHint(err: unknown): unknown {
  if (!(err instanceof FreeloApiError)) return err;
  if (err.httpStatus === 403) {
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: 'Account cannot edit custom-field values on this task.',
    });
  }
  return err;
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

function confirmMessage(count: number): string {
  if (count === 1) return 'Clear 1 custom-field value on a task?';
  return `Clear ${count} custom-field values on tasks?`;
}

function writeEnvelope(
  envelope: Envelope<CustomFieldsValueClearData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const line = renderCustomFieldsValueClearHuman(envelope.data);
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Write a per-line batch error envelope. Only called from the `--stdin`
 * NDJSON path (the CLI surface has no positional batch for `value clear` —
 * each job carries multiple fields), so `context.line_index` is the only
 * index shape used.
 */
function writeBatchError(
  err: BaseError,
  index: number,
  taskIdMaybe: number | null,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const idPart = taskIdMaybe === null ? '' : ` (task #${taskIdMaybe})`;
    process.stdout.write(`Failed item ${index + 1}${idPart}: ${err.message}\n`);
    return;
  }
  const httpStatus =
    'httpStatus' in err && typeof err.httpStatus === 'number' ? err.httpStatus : null;
  const requestId = 'requestId' in err && typeof err.requestId === 'string' ? err.requestId : null;
  const errors =
    'errors' in err && Array.isArray((err as { errors?: unknown }).errors)
      ? (err as { errors: string[] }).errors
      : undefined;
  const context: Record<string, number> = { line_index: index };
  if (taskIdMaybe !== null) context['task_id'] = taskIdMaybe;
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

function toBaseError(err: unknown): BaseError {
  if (err instanceof BaseError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ValidationError(message, {
    hintNext: 'Investigate the underlying error and retry the line.',
  });
}
