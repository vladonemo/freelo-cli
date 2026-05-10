/**
 * `freelo custom-fields value set --task <id> --field <uuid> (--value <str>|--enum <uuid>) [--dry-run]`
 * (R42, spec 0056).
 *
 * Upsert a custom-field value on a task. Two endpoints, dispatched on the
 * `--value` / `--enum` mutex:
 *   - `--value <str>`  → `POST /custom-field/add-or-edit-value` (yaml :4198-4244).
 *   - `--enum <uuid>`  → `POST /custom-field/add-or-edit-enum-value` (yaml :4246-4294).
 *
 * Not destructive of user data (upsert; history row is written but no other
 * fields are lost). No `--yes` gate. `--dry-run` is supported.
 *
 * Batch input: NDJSON via `--stdin` only (positional list does not fit because
 * each job carries multiple flags). Per-line shape:
 *   `{ "task_id": <int>, "field_uuid": "<uuid>", "value": "<str>" }`     (scalar)
 *   `{ "task_id": <int>, "field_uuid": "<uuid>", "enum": "<uuid>" }`     (enum)
 *
 * Output schema: `freelo.custom-fields.value-set/v1`.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../../config/schema.js';
import { resolveCredentials } from '../../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../../api/client.js';
import {
  addOrEditCustomFieldValue,
  addOrEditCustomFieldEnumValue,
  addOrEditCustomFieldValuePath,
  addOrEditCustomFieldEnumValuePath,
} from '../../../api/custom-fields.js';
import { type CustomFieldsValueSetData } from '../../../api/schemas/custom-field.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../../ui/envelope.js';
import { renderCustomFieldsValueSetHuman } from '../../../ui/human/custom-fields-value-set.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../../lib/batch.js';
import { handleTopLevelError } from '../../../errors/handle.js';
import { ValidationError } from '../../../errors/validation-error.js';
import { FreeloApiError } from '../../../errors/freelo-api-error.js';
import { BaseError } from '../../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.custom-fields.value-set/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.custom-fields.value-set/v1';

type SetOpts = {
  task?: number;
  field?: string;
  value?: string;
  enum?: string;
  stdin?: true;
  dryRun?: true;
};

type Job = {
  taskId: number;
  fieldUuid: string;
  kind: 'scalar' | 'enum';
  value: string;
};

/* ---------------------------------------------------------------------------
 *  Per-line NDJSON schema. Each line is one job. Mutex of `value` / `enum`
 *  enforced after parse (zod's `.refine` makes the path-error harder to read).
 * ------------------------------------------------------------------------- */

const BatchLineSchema = z
  .object({
    task_id: z.number().int().positive("'task_id' must be ≥ 1."),
    field_uuid: z.string().min(1, "'field_uuid' must be a non-empty string."),
    value: z.string().optional(),
    enum: z.string().optional(),
  })
  .strict();

/* ---------------------------------------------------------------------------
 *  Flag parsers — each throws ValidationError (BaseError, exit 2).
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

function parseUuidFlag(label: string, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(`${label} must be a non-empty uuid.`, {
      hintNext: `${label} is a uuid string. Run \`freelo custom-fields list --project <id>\` for field uuids.`,
    });
  }
  return trimmed;
}

function parseFieldFlag(raw: string): string {
  return parseUuidFlag('--field', raw);
}

function parseEnumFlag(raw: string): string {
  return parseUuidFlag('--enum', raw);
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerSet(
  value: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = value
    .command('set')
    .description(
      'Upsert a custom-field value on a task. Pass --value <str> for text/number fields or --enum <uuid> for enum fields (mutually exclusive). Use --stdin for NDJSON batch input.',
    )
    .option('--task <id>', 'Task id (positive integer).', parseTaskFlag)
    .option('--field <uuid>', 'Custom-field uuid.', parseFieldFlag)
    .option('--value <str>', 'Scalar value (text or number) to set. Mutex with --enum.')
    .option('--enum <uuid>', 'Enum-option uuid to set. Mutex with --value.', parseEnumFlag)
    .option(
      '--stdin',
      'Read NDJSON from stdin (one `{"task_id","field_uuid","value"|"enum"}` per line). Mutex with --task/--field/--value/--enum.',
    )
    .option('--dry-run', 'Skip the wire call. Envelope reflects what *would* have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (opts: SetOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      validateInputSources(opts);

      if (opts.stdin === true) {
        await runBatchFromStdin(opts, appConfig, env);
        return;
      }

      const job = resolveJobFromFlags(opts);
      const client = await buildClient(appConfig, env);
      await runOneJob(job, opts, appConfig, client, /* lineIndex */ undefined);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Cross-source validation
 * ------------------------------------------------------------------------- */

function validateInputSources(opts: SetOpts): void {
  const hasFlags =
    opts.task !== undefined ||
    opts.field !== undefined ||
    opts.value !== undefined ||
    opts.enum !== undefined;
  const hasStdin = opts.stdin === true;

  if (hasFlags && hasStdin) {
    throw new ValidationError(
      'Pick exactly one input source: --task/--field/--value|--enum or --stdin.',
      {
        hintNext: 'Combining input sources is ambiguous — agents should pre-resolve to one shape.',
      },
    );
  }
  if (!hasFlags && !hasStdin) {
    throw new ValidationError('No input supplied.', {
      hintNext:
        'Pass --task <id> --field <uuid> with either --value <str> or --enum <uuid>, or pipe NDJSON to --stdin.',
    });
  }
}

function resolveJobFromFlags(opts: SetOpts): Job {
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
  return resolveJobShape({
    taskId: opts.task,
    fieldUuid: opts.field,
    valueScalar: opts.value,
    valueEnum: opts.enum,
  });
}

function resolveJobShape(args: {
  taskId: number;
  fieldUuid: string;
  valueScalar: string | undefined;
  valueEnum: string | undefined;
}): Job {
  const hasScalar = args.valueScalar !== undefined;
  const hasEnum = args.valueEnum !== undefined;
  if (hasScalar && hasEnum) {
    throw new ValidationError('Pass exactly one of --value or --enum, not both.', {
      hintNext:
        'Use --value for text/number fields, --enum for enum fields. The two endpoints are distinct.',
    });
  }
  if (!hasScalar && !hasEnum) {
    throw new ValidationError('Pass exactly one of --value or --enum.', {
      hintNext:
        'Use --value for text/number fields, --enum for enum fields. Pick one based on the field type.',
    });
  }
  if (hasScalar) {
    return {
      taskId: args.taskId,
      fieldUuid: args.fieldUuid,
      kind: 'scalar',
      value: args.valueScalar!,
    };
  }
  return {
    taskId: args.taskId,
    fieldUuid: args.fieldUuid,
    kind: 'enum',
    value: args.valueEnum!,
  };
}

/* ---------------------------------------------------------------------------
 *  Batch from --stdin (NDJSON)
 * ------------------------------------------------------------------------- */

async function runBatchFromStdin(
  opts: SetOpts,
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

  if (allLines.length === 0) {
    return;
  }

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
    let job: Job;
    try {
      job = resolveJobShape({
        taskId: result.value.task_id,
        fieldUuid: result.value.field_uuid,
        valueScalar: result.value.value,
        valueEnum: result.value.enum,
      });
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, result.value.task_id, mode);
      exitAcc.observe(typed.exitCode);
      continue;
    }
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
 *  Per-job flow — dry-run / live POST / hint rewrite
 * ------------------------------------------------------------------------- */

async function runOneJob(
  job: Job,
  opts: SetOpts,
  appConfig: PartialAppConfig,
  client: HttpClient,
  lineIndex: number | undefined,
): Promise<void> {
  const mode = appConfig.output.mode;

  // ---- 1. Dry-run.
  if (opts.dryRun === true) {
    const path =
      job.kind === 'scalar' ? addOrEditCustomFieldValuePath() : addOrEditCustomFieldEnumValuePath();
    const body =
      job.kind === 'scalar'
        ? { custom_field_uuid: job.fieldUuid, task_id: job.taskId, value: job.value }
        : { customFieldUuid: job.fieldUuid, task_id: job.taskId, value: job.value };
    const data: CustomFieldsValueSetData = {
      task_id: job.taskId,
      field_uuid: job.fieldUuid,
      kind: job.kind,
      value_uuid: null,
      value: job.value,
      previous_value_uuid: null,
      would: { method: 'POST', path, body },
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope: Envelope<CustomFieldsValueSetData> = {
      schema: SCHEMA,
      data,
      dry_run: true,
    };
    if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
    writeEnvelope(envelope, mode);
    return;
  }

  // ---- 2. Live POST.
  try {
    let valueUuid: string | null;
    let raw;
    if (job.kind === 'scalar') {
      const result = await addOrEditCustomFieldValue(client, {
        taskId: job.taskId,
        customFieldUuid: job.fieldUuid,
        value: job.value,
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      raw = result.raw;
      valueUuid = result.body.custom_field_value?.uuid ?? null;
    } else {
      const result = await addOrEditCustomFieldEnumValue(client, {
        taskId: job.taskId,
        customFieldUuid: job.fieldUuid,
        value: job.value,
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      raw = result.raw;
      valueUuid = result.body.customFieldEnum?.uuid ?? null;
    }

    const data: CustomFieldsValueSetData = {
      task_id: job.taskId,
      field_uuid: job.fieldUuid,
      kind: job.kind,
      value_uuid: valueUuid,
      value: job.value,
      previous_value_uuid: null,
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope = buildEnvelope({
      schema: SCHEMA,
      data,
      rateLimit: {
        remaining: raw.rateLimit.remaining,
        reset_at: raw.rateLimit.resetAt,
      },
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    writeEnvelope(envelope, mode);
  } catch (err: unknown) {
    throw rewriteApiHint(err, job);
  }
}

/* ---------------------------------------------------------------------------
 *  Hint rewriting
 * ------------------------------------------------------------------------- */

/**
 * Map `FreeloApiError` thrown by either upsert endpoint to friendlier
 * `hintNext` for the well-known cases (spec 0056 §2.5):
 *
 *   - 400 mentioning `value` (scalar) → "scalar field expects a string. For enum use --enum."
 *   - 400 generic                    → server-side validation hint.
 *   - 404 mentioning "Enum" (enum)   → "Enum option uuid not found. Use `freelo custom-fields enum list` (R43)."
 *   - 404 generic                    → "Task or custom field not found."
 *   - 409                            → "Custom field is in a different project than the task."
 */
function rewriteApiHint(err: unknown, job: Job): unknown {
  if (!(err instanceof FreeloApiError)) return err;

  if (err.httpStatus === 400) {
    const haystack = [err.message, ...err.errors].join(' ');
    let hintNext: string;
    if (job.kind === 'scalar' && /value|checker/i.test(haystack)) {
      hintNext =
        'Scalar fields expect a string. For enum-typed fields use --enum <enum-option-uuid> instead.';
    } else {
      hintNext =
        'Server-side validation rejected the request; review the message and adjust flags.';
    }
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext,
    });
  }
  if (err.httpStatus === 404) {
    const haystack = [err.message, ...err.errors].join(' ');
    let hintNext: string;
    if (job.kind === 'enum' && /enum/i.test(haystack)) {
      hintNext =
        'Enum option uuid not found. Run `freelo custom-fields enum list --field <uuid>` once R43 ships, or check the option uuid.';
    } else {
      hintNext = 'Task or custom field not found. Verify --task and --field.';
    }
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext,
    });
  }
  if (err.httpStatus === 409) {
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext:
        'Custom field is in a different project than the task. The two must share a project.',
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

function writeEnvelope(
  envelope: Envelope<CustomFieldsValueSetData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const line = renderCustomFieldsValueSetHuman(envelope.data);
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Write a per-line batch error envelope. Only called from the `--stdin`
 * NDJSON path (the CLI surface has no positional batch for `value set` —
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
