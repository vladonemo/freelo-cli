/**
 * `freelo custom-fields delete <uuid>... [--ids <list>] [--stdin] [--yes] [--dry-run]`
 * (R41, spec 0055).
 *
 * Soft-deletes one or more custom-field definitions via
 * `DELETE /custom-field/delete/{uuid}` (yaml :4138-4166).
 *
 * Destructive — gates on the shared `confirmDestructive` helper (R13).
 *
 * Idempotency (spec 0055 decision 3 — single-arm, mirrors `labels/delete`):
 *   1. HTTP 404 → `already_in_target_state: true`, exit 0.
 *   2. Other non-2xx → re-throw `FreeloApiError`.
 *
 * Mirrors `src/commands/labels/delete.ts` modulo:
 *   (a) `<uuid>` positional instead of integer `<id>`,
 *   (b) `--ids` parser splits and validates uuids,
 *   (c) NDJSON line schema `{ uuid: string }`,
 *   (d) confirmation copy "Delete N custom field(s)?".
 *
 * Output schema: `freelo.custom-fields.delete/v1`.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { deleteCustomField, deleteCustomFieldPath } from '../../api/custom-fields.js';
import { type CustomFieldsDeleteData } from '../../api/schemas/custom-field.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderCustomFieldsDeleteHuman } from '../../ui/human/custom-fields-delete.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import { confirmDestructive } from '../../lib/confirm.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.custom-fields.delete/v1',
  destructive: true,
};

const SCHEMA: SchemaString = 'freelo.custom-fields.delete/v1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DeleteOpts = {
  ids?: string;
  stdin?: true;
  dryRun?: true;
};

/* ---------------------------------------------------------------------------
 *  Per-line NDJSON schema. `uuid` is a UUID string; nothing else allowed.
 * ------------------------------------------------------------------------- */

const BatchLineSchema = z
  .object({
    uuid: z.string().regex(UUID_RE, "'uuid' must be a UUID."),
  })
  .strict();

/* ---------------------------------------------------------------------------
 *  Input parsing
 * ------------------------------------------------------------------------- */

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

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerDelete(
  customFields: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = customFields
    .command('delete')
    .description(
      'Soft-delete one or more custom-field definitions. Existing task values are preserved server-side and hidden until restore. Destructive — requires --yes (non-TTY) or interactive confirmation (TTY). 404 treated as idempotent (already-deleted).',
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
      'Skip the DELETE per uuid. No confirmation prompt fires. Envelope reflects what *would* have been called.',
    );
  attachMeta(cmd, meta);

  cmd.action(async (uuids: string[] | undefined, opts: DeleteOpts, cmdCtx: Command) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;
    const yes = resolveYesFlag(cmdCtx);

    try {
      validateInputSources(uuids, opts);

      if (opts.stdin === true) {
        await runBatchFromStdin(opts, yes, appConfig, env);
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

      await runUuidList(resolvedUuids, opts, yes, appConfig, env);
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

function validateInputSources(uuids: string[] | undefined, opts: DeleteOpts): void {
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

/* ---------------------------------------------------------------------------
 *  Batch from positional / --ids
 * ------------------------------------------------------------------------- */

async function runUuidList(
  uuids: readonly string[],
  opts: DeleteOpts,
  yes: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;

  await confirmDestructive({
    promptMessage: confirmMessage(uuids.length),
    yes,
    dryRun: opts.dryRun === true,
  });

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

/* ---------------------------------------------------------------------------
 *  Batch from --stdin (NDJSON)
 * ------------------------------------------------------------------------- */

async function runBatchFromStdin(
  opts: DeleteOpts,
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

  if (allLines.length === 0) {
    return;
  }

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
 *  Per-uuid flow — dry-run / DELETE / single-arm 404 idempotency
 * ------------------------------------------------------------------------- */

async function runOneUuid(
  uuid: string,
  opts: DeleteOpts,
  appConfig: PartialAppConfig,
  client: HttpClient,
  lineIndex: number | undefined,
): Promise<void> {
  const mode = appConfig.output.mode;

  // ---- 1. Dry-run: skip the DELETE, emit envelope with `would`.
  if (opts.dryRun === true) {
    const data: CustomFieldsDeleteData = {
      uuid,
      previous_state: null,
      current_state: 'deleted',
      already_in_target_state: false,
      would: {
        method: 'DELETE',
        path: deleteCustomFieldPath(uuid),
        body: {},
      },
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope: Envelope<CustomFieldsDeleteData> = {
      schema: SCHEMA,
      data,
      dry_run: true,
    };
    if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
    writeEnvelope(envelope, mode);
    return;
  }

  // ---- 2. Live DELETE.
  try {
    const result = await deleteCustomField(client, uuid, {
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });

    const data: CustomFieldsDeleteData = {
      uuid,
      previous_state: null,
      current_state: 'deleted',
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
    return;
  } catch (err: unknown) {
    // ---- 3. Single-arm 404 idempotency (decision 3).
    if (err instanceof FreeloApiError && isIdempotentDeleteSkip(err)) {
      const data: CustomFieldsDeleteData = {
        uuid,
        previous_state: null,
        current_state: 'deleted',
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
 * Decide whether a `FreeloApiError` represents a second-delete on a custom
 * field that's already gone (idempotent skip) vs. a real failure. Single-arm
 * heuristic per spec 0055 decision 3:
 *
 *   1. HTTP 404 → idempotent skip.
 *   2. Otherwise → NOT idempotent.
 *
 * Exported for direct unit-test coverage of the matrix without the full
 * end-to-end harness (mirrors `labels/delete` decision 09).
 */
export function isIdempotentDeleteSkip(err: FreeloApiError): boolean {
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

function confirmMessage(count: number): string {
  if (count === 1) return 'Delete 1 custom field?';
  return `Delete ${count} custom fields?`;
}

function writeEnvelope(
  envelope: Envelope<CustomFieldsDeleteData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const line = renderCustomFieldsDeleteHuman(envelope.data);
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
