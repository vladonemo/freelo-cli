/**
 * `freelo labels delete <id>... [--ids <list>] [--stdin] [--yes] [--dry-run]`
 * (R23, spec 0035).
 *
 * Hard-deletes one or more project labels GLOBALLY (not just from a single
 * project — yaml :917) via `DELETE /project-labels/{labelId}`.
 *
 * Destructive — gates on the shared `confirmDestructive` helper (R13). The
 * confirmation copy explicitly says "GLOBALLY (across all projects)" so a
 * TTY user has a clear signal of scope (decision 10).
 *
 * Idempotency (spec 0035 decision 09 — two-arm heuristic):
 *   1. HTTP 404 → `already_in_target_state: true`, exit 0.
 *   2. Other non-2xx → re-throw `FreeloApiError`.
 *
 * Mirrors `src/commands/reports/delete.ts` byte-for-byte modulo
 * (a) field rename `report_id` → `label_id`, (b) two-arm vs four-arm
 * idempotency (no documented 400 fallback for already-deleted), and
 * (c) "GLOBALLY" confirmation copy.
 *
 * Output schema: `freelo.labels.delete/v1`.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { deleteProjectLabel, labelPath } from '../../api/project-labels.js';
import { type LabelsDeleteData } from '../../api/schemas/project-label.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderLabelsDeleteHuman } from '../../ui/human/labels-delete.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import { confirmDestructive } from '../../lib/confirm.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.labels.delete/v1',
  destructive: true,
};

const SCHEMA: SchemaString = 'freelo.labels.delete/v1';

type DeleteOpts = {
  ids?: string;
  stdin?: true;
  dryRun?: true;
};

/* ---------------------------------------------------------------------------
 *  Per-line NDJSON schema. Mirrors `reports/delete.ts`.
 * ------------------------------------------------------------------------- */

const BatchLineSchema = z
  .object({
    id: z.number().int("'id' must be an integer (no string-form).").positive("'id' must be ≥ 1."),
  })
  .strict();

/* ---------------------------------------------------------------------------
 *  Input parsing
 * ------------------------------------------------------------------------- */

function parsePositiveInt(label: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`${label} must be a positive integer.`, {
      hintNext: `${label} is the numeric label id from \`freelo labels list\`.`,
    });
  }
  return n;
}

function collectLabelId(raw: string, prev: number[] | undefined): number[] {
  const n = parsePositiveInt('<id>', raw);
  return prev ? [...prev, n] : [n];
}

function parseIdsFlag(raw: string): number[] {
  const tokens = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) {
    throw new ValidationError('--ids requires at least one id.', {
      hintNext: '--ids takes a comma- or space-separated list of numeric label ids.',
    });
  }
  return tokens.map((t) => parsePositiveInt('--ids', t));
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerDelete(
  labels: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = labels
    .command('delete')
    .description(
      'Hard-delete one or more project labels GLOBALLY (across all projects). Destructive — requires --yes (non-TTY) or interactive confirmation (TTY). 404 treated as idempotent (already-deleted).',
    )
    .argument('[id...]', 'One or more numeric label ids (positional).', collectLabelId)
    .option(
      '--ids <list>',
      'Comma- or space-separated list of label ids (mutex with positional <id> and --stdin).',
    )
    .option(
      '--stdin',
      'Read NDJSON from stdin (one `{"id": <int>}` per line). Mutex with positional and --ids.',
    )
    .option(
      '--dry-run',
      'Skip the DELETE per id. No confirmation prompt fires. Envelope reflects what *would* have been called.',
    );
  attachMeta(cmd, meta);

  cmd.action(async (ids: number[] | undefined, opts: DeleteOpts, cmdCtx: Command) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;
    const yes = resolveYesFlag(cmdCtx);

    try {
      validateInputSources(ids, opts);

      if (opts.stdin === true) {
        await runBatchFromStdin(opts, yes, appConfig, env);
        return;
      }

      const resolvedIds =
        ids !== undefined && ids.length > 0
          ? ids
          : opts.ids !== undefined
            ? parseIdsFlag(opts.ids)
            : [];

      if (resolvedIds.length === 0) {
        // No ids resolved → silent success (matches reports/delete).
        return;
      }

      await runIdList(resolvedIds, opts, yes, appConfig, env);
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

function validateInputSources(ids: number[] | undefined, opts: DeleteOpts): void {
  const hasPositional = ids !== undefined && ids.length > 0;
  const hasIdsFlag = opts.ids !== undefined && opts.ids.trim().length > 0;
  const hasStdin = opts.stdin === true;
  const sourceCount = (hasPositional ? 1 : 0) + (hasIdsFlag ? 1 : 0) + (hasStdin ? 1 : 0);
  if (sourceCount > 1) {
    throw new ValidationError(
      'Pick exactly one input source: positional <id>..., --ids, or --stdin.',
      {
        hintNext: 'Combining input sources is ambiguous — agents should pre-resolve to one shape.',
      },
    );
  }
  if (sourceCount === 0) {
    throw new ValidationError('No label ids supplied.', {
      hintNext: 'Pass numeric ids positionally, or use --ids "a,b,c", or pipe NDJSON to --stdin.',
    });
  }
}

/* ---------------------------------------------------------------------------
 *  Batch from positional / --ids
 * ------------------------------------------------------------------------- */

async function runIdList(
  ids: readonly number[],
  opts: DeleteOpts,
  yes: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;

  await confirmDestructive({
    promptMessage: confirmMessage(ids.length),
    yes,
    dryRun: opts.dryRun === true,
  });

  const client = await buildClient(appConfig, env);

  if (ids.length === 1) {
    await runOneId(ids[0]!, opts, appConfig, client, /* lineIndex */ undefined);
    return;
  }

  const exitAcc = new ExitCodeAccumulator();
  for (let i = 0; i < ids.length; i += 1) {
    const labelId = ids[i]!;
    try {
      await runOneId(labelId, opts, appConfig, client, /* lineIndex */ undefined);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, labelId, mode, /* fromStdin */ false);
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
      writeBatchError(result.error, i, /* idMaybe */ null, mode, /* fromStdin */ true);
      exitAcc.observe(result.error.exitCode);
      continue;
    }
    const labelId = result.value.id;
    try {
      const client = await getClient();
      await runOneId(labelId, opts, appConfig, client, /* lineIndex */ i);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, labelId, mode, /* fromStdin */ true);
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
 *  Per-id flow — dry-run / DELETE / two-arm idempotency
 * ------------------------------------------------------------------------- */

async function runOneId(
  labelId: number,
  opts: DeleteOpts,
  appConfig: PartialAppConfig,
  client: HttpClient,
  lineIndex: number | undefined,
): Promise<void> {
  const mode = appConfig.output.mode;

  // ---- 1. Dry-run.
  if (opts.dryRun === true) {
    const data: LabelsDeleteData = {
      label_id: labelId,
      previous_state: null,
      current_state: 'deleted',
      already_in_target_state: false,
      would: {
        method: 'DELETE',
        path: labelPath(labelId),
        body: {},
      },
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope: Envelope<LabelsDeleteData> = {
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
    const result = await deleteProjectLabel(client, labelId, {
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });

    const data: LabelsDeleteData = {
      label_id: labelId,
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
    // ---- 3. Two-arm idempotency heuristic (decision 09).
    if (err instanceof FreeloApiError && isIdempotentDeleteSkip(err)) {
      const data: LabelsDeleteData = {
        label_id: labelId,
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
    // Other errors bubble.
    throw err;
  }
}

/**
 * Decide whether a `FreeloApiError` represents a second-delete on a label
 * that's already gone (idempotent skip) vs. a real failure. Two-arm matrix
 * per spec 0035 decision 09:
 *
 *   1. HTTP 404 → idempotent skip.
 *   2. Otherwise → NOT idempotent.
 *
 * Exported for direct unit-test coverage of the matrix without the full
 * end-to-end harness.
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
  if (count === 1) return 'Delete 1 label GLOBALLY (across all projects)?';
  return `Delete ${count} labels GLOBALLY (across all projects)?`;
}

function writeEnvelope(
  envelope: Envelope<LabelsDeleteData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const line = renderLabelsDeleteHuman(envelope.data);
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function writeBatchError(
  err: BaseError,
  index: number,
  idMaybe: number | null,
  mode: 'human' | 'json' | 'ndjson',
  fromStdin: boolean,
): void {
  if (mode === 'human') {
    const idPart = idMaybe === null ? '' : ` (label #${idMaybe})`;
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
  const context: Record<string, number> = fromStdin
    ? { line_index: index }
    : { input_index: index };
  if (idMaybe !== null) context['label_id'] = idMaybe;
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
    hintNext: 'Investigate the underlying error and retry the id.',
  });
}
