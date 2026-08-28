/**
 * `freelo files delete <uuid>...` (M07, spec 0064).
 *
 * Deletes one or more files **or documents/notes** via
 * `DELETE /file/{file_uuid}` (yaml :4492-4521, `deleteDocOrFileByUuid`). The
 * endpoint resolves the resource kind from the UUID server-side, so a single
 * command covers both. Structurally a sibling of
 * `src/commands/comments/delete.ts` (M01) and `src/commands/tasks/delete.ts`
 * (R13) — same destructive-op shape, same batch surfaces, same confirmation
 * gate — on the same resource as `src/commands/files/download.ts` (R27).
 *
 * The only shape difference from its two siblings: ids are UUID strings, not
 * integers.
 *
 * Surfaces:
 *   - Single uuid positional: `files delete 3f7c…a41 --yes`.
 *   - Multi positional: `files delete 3f7c…a41 8a2b…b56 --yes`.
 *   - `--ids "a,b,c"` flag (mutex with positional and `--stdin`).
 *   - `--stdin` NDJSON (mutex with positional and `--ids`).
 *   - `--dry-run` (any input source) — skips the wire call AND the
 *     confirmation prompt (no destructive effect).
 *   - `--yes` — bypasses the confirmation prompt (global flag).
 *
 * There is no `-` stdin sentinel here — delete has no content, so `-` denotes
 * nothing and falls through the ordinary `<uuid>` parser as invalid.
 *
 * Confirmation policy (spec 0064 §2.3, delegated to `src/lib/confirm.ts`):
 *   - `--yes` → unconditional proceed.
 *   - `--dry-run` → unconditional proceed (no destructive effect).
 *   - TTY without `--yes` → prompt once for the whole run (N resources).
 *     User declines → `ConfirmationError` (exit 2), no wire calls.
 *   - Non-TTY without `--yes` → `ConfirmationError` (exit 2) immediately,
 *     no wire calls, no credential resolution.
 *
 * **The load-bearing part of this slice (spec 0064 §5.1): a 404 is an error,
 * NOT idempotent success.** R13's `tasks delete` re-classifies a 404 on DELETE
 * as success-with-`already_in_target_state: true`. This command deliberately
 * does not. Per yaml :4504 a 404 here means *either* "no file or document
 * matches the UUID" *or* "the caller has no access to it" — Freelo returns 404
 * rather than 403 so inaccessible resources aren't leaked — so absorbing it
 * would report `exit 0` / "deleted" for a document still sitting untouched in a
 * project the caller cannot see. That is the one failure mode a delete command
 * must never have. The message stays a **plain** not-found; the ACL nuance
 * lives in `hint_next` only, never in the message. See decision 3; pinned by a
 * regression test so a later "let's make the deletes consistent" refactor fails
 * loudly.
 *
 * Unlike M01 there is **no 400 rewrite** — this endpoint documents no 400 at
 * all (only 200 and 404), and inventing a message for an undocumented status
 * would be guessing at API behavior.
 *
 * Output schema: `freelo.files.delete/v1`.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { deleteFile, deleteFilePath, type DeleteFileResult } from '../../api/files-delete.js';
import { type FilesDeleteData } from '../../api/schemas/file.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderFilesDeleteHuman } from '../../ui/human/files-delete.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import { confirmDestructive } from '../../lib/confirm.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.files.delete/v1',
  destructive: true,
};

const SCHEMA: SchemaString = 'freelo.files.delete/v1';

/**
 * Strict 8-4-4-4-12 hex pattern. Duplicated from
 * `src/commands/files/download.ts` :52 rather than shared, matching the
 * codebase's established habit of keeping tiny input parsers local to the
 * command file (M01 re-declares `parsePositiveInt` beside R13's copy). See
 * decision 4.
 */
const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type DeleteOpts = {
  ids?: string;
  stdin?: true;
  dryRun?: true;
};

/* ---------------------------------------------------------------------------
 *  Per-line NDJSON schema (--stdin batch mode). `.strict()` so a typo'd key
 *  (`{"id": …}`, `{"file_uuid": …}`) surfaces as a per-line error rather than
 *  being silently ignored. The uuid value goes through the same 8-4-4-4-12
 *  check as the positional form, so a malformed UUID never reaches the wire.
 * ------------------------------------------------------------------------- */

const BatchLineSchema = z
  .object({
    uuid: z.string().regex(UUID_REGEX, 'uuid must be a UUID (8-4-4-4-12 hex pattern).'),
  })
  .strict();

/* ---------------------------------------------------------------------------
 *  Input parsing (Commander parsers throw `ValidationError` (BaseError, exit
 *  2) — NOT Commander's `InvalidArgumentError` which would map to exit 1.
 *  Calibration §1-2.
 * ------------------------------------------------------------------------- */

function parseUuid(label: string, raw: string): string {
  if (!UUID_REGEX.test(raw)) {
    throw new ValidationError(`${label} must be a UUID (8-4-4-4-12 hex pattern).`, {
      hintNext: `${label} is the file or document UUID (from \`freelo files list\`).`,
    });
  }
  return raw;
}

/**
 * Variadic `<uuid>...` collector. Commander invokes this once per token; bad
 * tokens surface as `ValidationError` at parse time.
 */
function collectFileUuid(raw: string, prev: string[] | undefined): string[] {
  const uuid = parseUuid('<uuid>', raw);
  return prev ? [...prev, uuid] : [uuid];
}

function parseIdsFlag(raw: string): string[] {
  const tokens = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) {
    throw new ValidationError('--ids requires at least one UUID.', {
      hintNext: '--ids takes a comma- or space-separated list of file or document UUIDs.',
    });
  }
  return tokens.map((t) => parseUuid('--ids', t));
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerDelete(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = parent
    .command('delete')
    .description(
      'Delete one or more files or documents/notes by UUID. The endpoint resolves which kind the UUID refers to, so one command covers both. Deletion is a soft-delete — the resource is marked deleted, not physically removed, and there is no undelete endpoint. Destructive — requires --yes (non-TTY) or interactive confirmation (TTY). Unlike `tasks delete`, a 404 is reported as an error, not as an idempotent already-deleted success, because Freelo returns 404 both for resources that are gone and for ones you cannot see.',
    )
    .argument('[uuid...]', 'One or more file or document UUIDs (positional).', collectFileUuid)
    .option(
      '--ids <list>',
      'Comma- or space-separated list of file or document UUIDs (mutex with positional <uuid> and --stdin).',
    )
    .option(
      '--stdin',
      'Read NDJSON from stdin (one `{"uuid": "<string>"}` per line). Mutex with positional and --ids.',
    )
    .option(
      '--dry-run',
      'Skip the DELETE per UUID. No confirmation prompt fires. Envelope reflects what *would* have been called.',
    );
  // NOTE: `--yes` / `-y` is the **global** flag (registered on the root
  // program in `src/bin/freelo.ts`). Commander binds it to the root program's
  // opts, not the subcommand's — we read it via `resolveYesFlag(cmd)` below.
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
        // No UUIDs resolved from any source → silent success (matches
        // R09/R11/R13/M01 batch convention; spec 0064 §2.2).
        return;
      }

      await runUuidList(resolvedUuids, opts, yes, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/**
 * Walk the Commander tree up to the root program and read the global `--yes`
 * (`-y`) flag. Mirrors `src/commands/comments/delete.ts` — the flag is
 * registered on the root program, so subcommand opts do NOT carry it.
 *
 * Defensive: if the root cannot be reached (test harness with a detached
 * command), fall back to `false` (the safe default).
 */
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
 *  Cross-source validation (mirrors R13/M01)
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
    throw new ValidationError('No file UUIDs supplied.', {
      hintNext:
        'Pass UUIDs positionally, or use --ids "a,b,c", or pipe NDJSON to --stdin. `freelo files list` shows the UUIDs you can see.',
    });
  }
}

/* ---------------------------------------------------------------------------
 *  Batch from positional / --ids
 *
 *  Confirmation fires once for the whole run (spec 0064 §2.3). Single-mode
 *  error semantics mirror R11/R13/M01: errors bubble for one-uuid runs, per-item
 *  envelopes for multi-uuid runs.
 * ------------------------------------------------------------------------- */

async function runUuidList(
  uuids: readonly string[],
  opts: DeleteOpts,
  yes: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;

  // 1. Confirmation gate (once for the whole run).
  await confirmDestructive({
    promptMessage: confirmMessage(uuids.length),
    yes,
    dryRun: opts.dryRun === true,
  });

  // 2. Dry-run never resolves credentials — there is no wire call to
  //    authenticate. Mirrors M01's null-client dry-run path.
  const client = opts.dryRun === true ? null : await buildClient(appConfig, env);

  if (uuids.length === 1) {
    // Single-uuid mode: errors bubble to the top-level handler so the agent
    // sees ONE envelope on stderr (matches R11/R12/R13/M01 single-mode contract).
    await runOneUuid(uuids[0]!, opts, appConfig, client, /* lineIndex */ undefined);
    return;
  }

  // Multi-uuid mode: per-item error envelopes go to stdout (the success stream)
  // and the highest exit code wins at end-of-loop. Same shape as R11/R13/M01.
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
 *
 *  Mirrors R11/R13/M01: buffer stdin → confirm once → per-line parse + run
 *  interleaved → defer-exit at end-of-loop.
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
    // Empty stdin → silent success exit 0 (matches R09/R11/R13/M01; spec 0064 §2.2).
    return;
  }

  // Confirmation fires AFTER buffering (R13 decision 7) so empty stdin never
  // prompts. We use the line count, not the count of valid rows — the user is
  // consenting to "I sent N lines, please process them"; per-line errors
  // afterwards are continue-on-error semantics, not a confirmation concern.
  await confirmDestructive({
    promptMessage: confirmMessage(allLines.length),
    yes,
    dryRun: opts.dryRun === true,
  });

  // Lazy client construction — a stdin of all-bad lines never reaches
  // credential resolution (mirrors R09/R11/R13/M01).
  let lazyClient: HttpClient | undefined;
  const getClient = async (): Promise<HttpClient> => {
    if (lazyClient === undefined) {
      lazyClient = await buildClient(appConfig, env);
    }
    return lazyClient;
  };

  // Process lines in input order so the NDJSON output stream's order matches
  // stdin (R11 fix — spec 0021 §3.5).
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
      const client = opts.dryRun === true ? null : await getClient();
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
 *  Per-uuid flow — dry-run / DELETE
 *
 *  Spec 0064 §5.1: no 404 absorption, no pre-check GET. The DELETE response is
 *  the source of truth and a failure stays a failure. (A pre-check GET couldn't
 *  disambiguate anyway — it sits behind the same ACL.)
 * ------------------------------------------------------------------------- */

async function runOneUuid(
  uuid: string,
  opts: DeleteOpts,
  appConfig: PartialAppConfig,
  client: HttpClient | null,
  lineIndex: number | undefined,
): Promise<void> {
  const mode = appConfig.output.mode;

  // ---- 1. Dry-run: skip the DELETE, emit envelope with `would`.
  if (opts.dryRun === true) {
    const data: FilesDeleteData = {
      uuid,
      current_state: 'deleted',
      already_in_target_state: false,
      would: {
        method: 'DELETE',
        path: deleteFilePath(uuid),
        body: {},
      },
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope: Envelope<FilesDeleteData> = {
      schema: SCHEMA,
      data,
      dry_run: true,
    };
    if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
    writeEnvelope(envelope, mode);
    return;
  }

  // ---- 2. Live DELETE.
  // Defensive: live mode should always have a client; throw if not (caller bug).
  if (client === null) {
    throw new ValidationError('Internal: HTTP client missing for live delete.', {
      hintNext: 'This is a programming bug — please file an issue.',
    });
  }

  let result: DeleteFileResult;
  try {
    result = await deleteFile(client, uuid, {
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    // No 404 re-classification here — see the file header and spec 0064 §5.1.
    // The rewriter only improves message/hint; it never converts an error into
    // a success.
    throw rewriteDeleteFileError(err, uuid);
  }

  const data: FilesDeleteData = {
    uuid,
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
}

/* ---------------------------------------------------------------------------
 *  Endpoint-specific error rewriting (spec 0064 §5.2)
 * ------------------------------------------------------------------------- */

/**
 * Rewrite the one `DELETE /file/{file_uuid}` failure the OpenAPI documents
 * explicitly. Everything else passes through untouched — notably there is **no**
 * 400 branch, because this endpoint documents no 400 (only 200 and 404) and
 * inventing a message for an undocumented status would be guessing.
 *
 * **404** — kept a **plain** not-found (decision 3). The message never says
 * "forbidden" or "permission": per yaml :4504 a 404 means the resource is
 * missing *or* invisible to the caller, and the CLI genuinely cannot tell which,
 * so asserting either would be a fabrication. The ACL nuance lives only in
 * `hint_next`, which is where a human or agent looks after the headline.
 *
 * `code`, `exitCode`, `retryable`, `errors`, `httpStatus` and `requestId` are
 * preserved — this is presentation, not reclassification, and emphatically not
 * a conversion into success.
 */
function rewriteDeleteFileError(err: unknown, uuid: string): unknown {
  if (!(err instanceof FreeloApiError)) return err;

  if (err.httpStatus === 404) {
    return new FreeloApiError(`File or document ${uuid} not found.`, err.code, {
      httpStatus: err.httpStatus,
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: `It may not exist, it may already be deleted, or you may not have access to it — Freelo returns 404 rather than 403 for resources you cannot see, so the cases are indistinguishable from the API (docs/api/freelo-api.yaml :4504). Run \`freelo files list\` to see what is visible to you.`,
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
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

/**
 * Build the prompt copy for the confirmation gate. Singular vs. plural matters
 * for human readability; agents won't see this string (they pass `--yes`).
 *
 * "file or document" for the same reason the renderer says it — we don't know
 * which kind the UUID points at until the server resolves it (spec 0064 §6.2).
 */
function confirmMessage(count: number): string {
  if (count === 1) return 'Delete 1 file or document?';
  return `Delete ${count} files or documents?`;
}

function writeEnvelope(
  envelope: Envelope<FilesDeleteData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const line = renderFilesDeleteHuman(envelope.data);
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Per-item error envelope writer for batch mode. Mirrors R13/M01's shape:
 * `freelo.error/v1` augmented with `context.line_index` (stdin) or
 * `context.input_index` (positional / --ids), plus `context.uuid` when the item
 * parsed.
 *
 * Calibration §4: covered by tests (mixed-batch rows).
 */
function writeBatchError(
  err: BaseError,
  index: number,
  uuidMaybe: string | null,
  mode: 'human' | 'json' | 'ndjson',
  fromStdin: boolean,
): void {
  if (mode === 'human') {
    const idPart = uuidMaybe === null ? '' : ` (${uuidMaybe})`;
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

/**
 * Coerce an unknown thrown value into a `BaseError`. Mirrors R11/R13/M01. Any
 * throw that isn't already a `BaseError` (defensive — e.g. a programming bug
 * surfacing as a plain `Error`) maps to `VALIDATION_ERROR` (exit 2).
 */
function toBaseError(err: unknown): BaseError {
  if (err instanceof BaseError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ValidationError(message, {
    hintNext: 'Investigate the underlying error and retry the UUID.',
  });
}
