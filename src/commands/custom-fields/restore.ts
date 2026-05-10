/**
 * `freelo custom-fields restore <uuid>... [--ids <list>] [--stdin] [--dry-run]`
 * (R41, spec 0055).
 *
 * Restores one or more soft-deleted custom-field definitions via
 * `POST /custom-field/restore/{uuid}` (yaml :4168-4196).
 *
 * Non-destructive (it brings hidden data back; no `--yes`, no confirmation
 * gate). Batch via positional / `--ids` / `--stdin` (NDJSON `{uuid}`).
 *
 * Idempotency (spec 0055 decision 3 — same single-arm heuristic as delete):
 *   1. HTTP 404 → `already_in_target_state: true`, exit 0. The OpenAPI
 *      conflates "doesn't exist" with "was never soft-deleted" (yaml :4177);
 *      both map to "user got the active end-state they asked for".
 *   2. Other non-2xx → re-throw `FreeloApiError`.
 *
 * Output schema: `freelo.custom-fields.restore/v1`.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { restoreCustomField, restoreCustomFieldPath } from '../../api/custom-fields.js';
import { type CustomFieldsRestoreData } from '../../api/schemas/custom-field.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderCustomFieldsRestoreHuman } from '../../ui/human/custom-fields-restore.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.custom-fields.restore/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.custom-fields.restore/v1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RestoreOpts = {
  ids?: string;
  stdin?: true;
  dryRun?: true;
};

const BatchLineSchema = z
  .object({
    uuid: z.string().regex(UUID_RE, "'uuid' must be a UUID."),
  })
  .strict();

function parseUuidToken(label: string, raw: string): string {
  if (!UUID_RE.test(raw)) {
    throw new ValidationError(`${label} must be a UUID.`, {
      hintNext: `${label} is the custom-field uuid from \`freelo custom-fields list --project <id>\`.`,
    });
  }
  return raw;
}

function collectUuid(raw: string, prev: string[] | undefined): string[] {
  const u = parseUuidToken('<uuid>', raw);
  return prev ? [...prev, u] : [u];
}

function parseIdsFlag(raw: string): string[] {
  const tokens = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) {
    throw new ValidationError('--ids requires at least one uuid.', {
      hintNext: '--ids takes a comma- or space-separated list of custom-field uuids.',
    });
  }
  return tokens.map((t) => parseUuidToken('--ids', t));
}

export function registerRestore(
  customFields: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = customFields
    .command('restore')
    .description(
      'Restore one or more soft-deleted custom-field definitions. Non-destructive — no --yes flag. 404 treated as idempotent (already-active or never-deleted).',
    )
    .argument('[uuid...]', 'One or more custom-field uuids (positional).', collectUuid)
    .option(
      '--ids <list>',
      'Comma- or space-separated list of custom-field uuids (mutex with positional <uuid> and --stdin).',
    )
    .option(
      '--stdin',
      'Read NDJSON from stdin (one `{"uuid": "..."}` per line). Mutex with positional and --ids.',
    )
    .option(
      '--dry-run',
      'Skip the POST per uuid. Envelope reflects what *would* have been called.',
    );
  attachMeta(cmd, meta);

  cmd.action(async (uuids: string[] | undefined, opts: RestoreOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      validateInputSources(uuids, opts);

      if (opts.stdin === true) {
        await runBatchFromStdin(opts, appConfig, env);
        return;
      }

      const resolvedUuids =
        uuids !== undefined && uuids.length > 0
          ? uuids
          : opts.ids !== undefined
            ? parseIdsFlag(opts.ids)
            : [];

      if (resolvedUuids.length === 0) {
        return;
      }

      await runUuidList(resolvedUuids, opts, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

function validateInputSources(uuids: string[] | undefined, opts: RestoreOpts): void {
  const hasPositional = uuids !== undefined && uuids.length > 0;
  const hasIdsFlag = opts.ids !== undefined && opts.ids.trim().length > 0;
  const hasStdin = opts.stdin === true;
  const sourceCount = (hasPositional ? 1 : 0) + (hasIdsFlag ? 1 : 0) + (hasStdin ? 1 : 0);
  if (sourceCount > 1) {
    throw new ValidationError(
      'Pick exactly one input source: positional <uuid>..., --ids, or --stdin.',
      {
        hintNext: 'Combining input sources is ambiguous — agents should pre-resolve to one shape.',
      },
    );
  }
  if (sourceCount === 0) {
    throw new ValidationError('No custom-field uuids supplied.', {
      hintNext: 'Pass uuids positionally, or use --ids "a,b,c", or pipe NDJSON to --stdin.',
    });
  }
}

async function runUuidList(
  uuids: readonly string[],
  opts: RestoreOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;

  const client = await buildClient(appConfig, env);

  if (uuids.length === 1) {
    await runOneUuid(uuids[0]!, opts, appConfig, client, /* lineIndex */ undefined);
    return;
  }

  const exitAcc = new ExitCodeAccumulator();
  for (let i = 0; i < uuids.length; i += 1) {
    const uuid = uuids[i]!;
    try {
      await runOneUuid(uuid, opts, appConfig, client, /* lineIndex */ undefined);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, uuid, mode, /* fromStdin */ false);
      exitAcc.observe(typed.exitCode);
    }
  }

  if (exitAcc.value !== 0) {
    const { drainDispatcher, exitDeferred } = await import('../../errors/handle.js');
    await drainDispatcher();
    await exitDeferred(exitAcc.value);
  }
}

async function runBatchFromStdin(
  opts: RestoreOpts,
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
      writeBatchError(result.error, i, /* uuidMaybe */ null, mode, /* fromStdin */ true);
      exitAcc.observe(result.error.exitCode);
      continue;
    }
    const uuid = result.value.uuid;
    try {
      const client = await getClient();
      await runOneUuid(uuid, opts, appConfig, client, /* lineIndex */ i);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, uuid, mode, /* fromStdin */ true);
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
 *  Per-uuid flow — dry-run / POST / single-arm 404 idempotency
 * ------------------------------------------------------------------------- */

async function runOneUuid(
  uuid: string,
  opts: RestoreOpts,
  appConfig: PartialAppConfig,
  client: HttpClient,
  lineIndex: number | undefined,
): Promise<void> {
  const mode = appConfig.output.mode;

  // ---- 1. Dry-run.
  if (opts.dryRun === true) {
    const data: CustomFieldsRestoreData = {
      uuid,
      previous_state: null,
      current_state: 'active',
      already_in_target_state: false,
      would: {
        method: 'POST',
        path: restoreCustomFieldPath(uuid),
        body: {},
      },
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope: Envelope<CustomFieldsRestoreData> = {
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
    const result = await restoreCustomField(client, uuid, {
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });

    const data: CustomFieldsRestoreData = {
      uuid,
      previous_state: null,
      current_state: 'active',
      already_in_target_state: false,
      custom_field: result.body.custom_field,
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
    return;
  } catch (err: unknown) {
    // ---- 3. Single-arm 404 idempotency. No `custom_field` echo on this path
    //         — we don't know it (and don't want to issue a follow-up GET).
    if (err instanceof FreeloApiError && isIdempotentRestoreSkip(err)) {
      const data: CustomFieldsRestoreData = {
        uuid,
        previous_state: null,
        current_state: 'active',
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
    throw err;
  }
}

/**
 * Decide whether a `FreeloApiError` represents a restore-of-already-active
 * (idempotent skip) vs. a real failure. Single-arm heuristic per spec 0055
 * decision 3:
 *
 *   1. HTTP 404 → idempotent skip. (OpenAPI conflates "doesn't exist" with
 *      "was never soft-deleted"; both map to "already-active end-state".)
 *   2. Otherwise → NOT idempotent.
 *
 * Exported for direct unit-test coverage of the matrix without the full
 * end-to-end harness.
 */
export function isIdempotentRestoreSkip(err: FreeloApiError): boolean {
  return err.httpStatus === 404;
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
  envelope: Envelope<CustomFieldsRestoreData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const line = renderCustomFieldsRestoreHuman(envelope.data);
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function writeBatchError(
  err: BaseError,
  index: number,
  uuidMaybe: string | null,
  mode: 'human' | 'json' | 'ndjson',
  fromStdin: boolean,
): void {
  if (mode === 'human') {
    const idPart = uuidMaybe === null ? '' : ` (uuid ${uuidMaybe})`;
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
  const context: Record<string, number | string> = fromStdin
    ? { line_index: index }
    : { input_index: index };
  if (uuidMaybe !== null) context['uuid'] = uuidMaybe;
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
    hintNext: 'Investigate the underlying error and retry the uuid.',
  });
}
