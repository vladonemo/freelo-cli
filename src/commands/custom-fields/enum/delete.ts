/**
 * `freelo custom-fields enum delete <enum_uuid>... [--ids <list>] [--stdin] [--force] [--yes] [--dry-run]`
 * (R43, spec 0057).
 *
 * Deletes one or more enum options. Two endpoints, picked by `--force`:
 *   - safe (default): `DELETE /custom-field-enum/delete/{uuid}` (yaml :4466-4495)
 *     — server refuses (4xx) if the option is referenced by any task value.
 *   - cascading (--force): `DELETE /custom-field-enum/force-delete/{uuid}`
 *     (yaml :4497-4527) — clears referencing task values; no undo.
 *
 * Destructive — gates on the shared `confirmDestructive` helper. Confirmation
 * copy diverges by mode so `--force` is never silent (spec 0057 §2.5).
 *
 * Idempotency (single-arm): HTTP 404 → `already_in_target_state: true`,
 * exit 0. Other non-2xx → re-throw `FreeloApiError`.
 *
 * Mirrors `src/commands/custom-fields/delete.ts` modulo:
 *   (a) lookup hint refers to `enum list --field` instead of `list --project`,
 *   (b) `--force` selects the cascading endpoint (decision 2),
 *   (c) confirmation copy is "Force-delete N enum option(s)?" when --force,
 *   (d) envelope `data.force` echoes the flag for audit trails.
 *
 * Output schema: `freelo.custom-fields.enum-delete/v1`.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../../config/schema.js';
import { resolveCredentials } from '../../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../../api/client.js';
import { deleteCustomFieldEnum, deleteCustomFieldEnumPath } from '../../../api/custom-fields.js';
import { type CustomFieldsEnumDeleteData } from '../../../api/schemas/custom-field.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../../ui/envelope.js';
import { renderCustomFieldsEnumDeleteHuman } from '../../../ui/human/custom-fields-enum-delete.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../../lib/batch.js';
import { confirmDestructive } from '../../../lib/confirm.js';
import { handleTopLevelError } from '../../../errors/handle.js';
import { ValidationError } from '../../../errors/validation-error.js';
import { FreeloApiError } from '../../../errors/freelo-api-error.js';
import { BaseError } from '../../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.custom-fields.enum-delete/v1',
  destructive: true,
};

const SCHEMA: SchemaString = 'freelo.custom-fields.enum-delete/v1';

type DeleteOpts = {
  ids?: string;
  stdin?: true;
  force?: true;
  dryRun?: true;
};

/* ---------------------------------------------------------------------------
 *  Per-line NDJSON schema. `uuid` is a non-empty string; nothing else allowed.
 *  We don't strictly UUID-validate (server is the source of truth on uuid
 *  format and Freelo's enum-option uuids may not be RFC-4122 UUIDs in all
 *  cases — keep this loose like `value clear`).
 * ------------------------------------------------------------------------- */

const BatchLineSchema = z
  .object({
    uuid: z.string().min(1, "'uuid' must be a non-empty string."),
  })
  .strict();

/* ---------------------------------------------------------------------------
 *  Input parsing
 * ------------------------------------------------------------------------- */

function parseUuidToken(label: string, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(`${label} must be a non-empty uuid.`, {
      hintNext: `${label} is the enum-option uuid from \`freelo custom-fields enum list --field <uuid>\`.`,
    });
  }
  return trimmed;
}

function collectUuid(raw: string, prev: string[] | undefined): string[] {
  const u = parseUuidToken('<enum_uuid>', raw);
  return prev ? [...prev, u] : [u];
}

function parseIdsFlag(raw: string): string[] {
  const tokens = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) {
    throw new ValidationError('--ids requires at least one uuid.', {
      hintNext: '--ids takes a comma- or space-separated list of enum-option uuids.',
    });
  }
  return tokens.map((t) => parseUuidToken('--ids', t));
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerEnumDelete(
  enumCmd: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = enumCmd
    .command('delete')
    .description(
      'Delete one or more enum options. Default (safe) refuses if the option is in use; --force cascades — referencing task values are cleared. Destructive — requires --yes (non-TTY) or interactive confirmation (TTY). 404 treated as idempotent (already-deleted).',
    )
    .argument('[enum_uuid...]', 'One or more enum-option uuids (positional).', collectUuid)
    .option(
      '--ids <list>',
      'Comma- or space-separated list of enum-option uuids (mutex with positional and --stdin).',
    )
    .option(
      '--stdin',
      'Read NDJSON from stdin (one `{"uuid": "..."}` per line). Mutex with positional and --ids.',
    )
    .option('--force', 'Use the cascading endpoint — referencing task values are CLEARED. No undo.')
    .option(
      '--dry-run',
      'Skip the DELETE per uuid. No confirmation prompt fires. Envelope reflects what *would* have been called.',
    );
  attachMeta(cmd, meta);

  cmd.action(async (uuids: string[] | undefined, opts: DeleteOpts, cmdCtx: Command) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;
    const yes = resolveYesFlag(cmdCtx);
    const force = opts.force === true;

    try {
      validateInputSources(uuids, opts);

      if (opts.stdin === true) {
        await runBatchFromStdin(opts, force, yes, appConfig, env);
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

      await runUuidList(resolvedUuids, opts, force, yes, appConfig, env);
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
      'Pick exactly one input source: positional <enum_uuid>..., --ids, or --stdin.',
      {
        hintNext: 'Combining input sources is ambiguous — agents should pre-resolve to one shape.',
      },
    );
  }
  if (sourceCount === 0) {
    throw new ValidationError('No enum-option uuids supplied.', {
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
  force: boolean,
  yes: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;

  await confirmDestructive({
    promptMessage: confirmMessage(uuids.length, force),
    yes,
    dryRun: opts.dryRun === true,
  });

  const client = await buildClient(appConfig, env);

  if (uuids.length === 1) {
    await runOneUuid(uuids[0]!, opts, force, appConfig, client, /* lineIndex */ undefined);
    return;
  }

  const exitAcc = new ExitCodeAccumulator();
  for (let i = 0; i < uuids.length; i += 1) {
    const uuid = uuids[i]!;
    try {
      await runOneUuid(uuid, opts, force, appConfig, client, /* lineIndex */ undefined);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, uuid, mode, /* fromStdin */ false);
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
 *  Batch from --stdin (NDJSON)
 * ------------------------------------------------------------------------- */

async function runBatchFromStdin(
  opts: DeleteOpts,
  force: boolean,
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
    promptMessage: confirmMessage(allLines.length, force),
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
      await runOneUuid(uuid, opts, force, appConfig, client, /* lineIndex */ i);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, uuid, mode, /* fromStdin */ true);
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
 *  Per-uuid flow — dry-run / DELETE / single-arm 404 idempotency
 * ------------------------------------------------------------------------- */

async function runOneUuid(
  uuid: string,
  opts: DeleteOpts,
  force: boolean,
  appConfig: PartialAppConfig,
  client: HttpClient,
  lineIndex: number | undefined,
): Promise<void> {
  const mode = appConfig.output.mode;

  // ---- 1. Dry-run: skip the DELETE, emit envelope with `would`.
  if (opts.dryRun === true) {
    const data: CustomFieldsEnumDeleteData = {
      uuid,
      force,
      previous_state: null,
      current_state: 'deleted',
      already_in_target_state: false,
      would: {
        method: 'DELETE',
        path: deleteCustomFieldEnumPath(uuid, force),
        body: {},
      },
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope: Envelope<CustomFieldsEnumDeleteData> = {
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
    const result = await deleteCustomFieldEnum(client, uuid, {
      force,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });

    const data: CustomFieldsEnumDeleteData = {
      uuid,
      force,
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
    // ---- 3. Single-arm 404 idempotency.
    if (err instanceof FreeloApiError && isIdempotentDeleteSkip(err)) {
      const data: CustomFieldsEnumDeleteData = {
        uuid,
        force,
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
    throw rewriteApiHint(err, force);
  }
}

/**
 * Single-arm 404 → idempotent skip (decision 4). Exported for direct unit-test
 * coverage of the matrix.
 */
export function isIdempotentDeleteSkip(err: FreeloApiError): boolean {
  return err.httpStatus === 404;
}

/**
 * Map well-known `FreeloApiError` cases to friendlier hints.
 *
 * - 400 (only relevant on the safe path) → "Enum option is in use; retry with --force."
 * - 403                                   → permission hint.
 * - Other → unchanged.
 */
function rewriteApiHint(err: unknown, force: boolean): unknown {
  if (!(err instanceof FreeloApiError)) return err;
  if (err.httpStatus === 400 && !force) {
    return rebrand(
      err,
      'Enum option is in use by tasks. Retry with --force to cascade-clear referencing values.',
    );
  }
  if (err.httpStatus === 403) {
    return rebrand(err, "Account is not a project commander on the field's project.");
  }
  return err;
}

function rebrand(err: FreeloApiError, hintNext: string): FreeloApiError {
  return new FreeloApiError(err.message, err.code, {
    ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
    errors: err.errors,
    rawBody: err.rawBody,
    hintNext,
  });
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

function confirmMessage(count: number, force: boolean): string {
  if (force) {
    if (count === 1) {
      return 'Force-delete 1 enum option? Referencing task values will be CLEARED.';
    }
    return `Force-delete ${count} enum options? Referencing task values will be CLEARED.`;
  }
  if (count === 1) return 'Delete 1 enum option?';
  return `Delete ${count} enum options?`;
}

function writeEnvelope(
  envelope: Envelope<CustomFieldsEnumDeleteData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const line = renderCustomFieldsEnumDeleteHuman(envelope.data);
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
