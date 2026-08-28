/**
 * `freelo comments delete <id>...` (M01, spec 0061 — supersedes R18.5).
 *
 * Deletes one or more comments via `DELETE /comment/{comment_id}`
 * (yaml :3203-3232, `deleteComment`). Structurally a sibling of
 * `src/commands/tasks/delete.ts` (R13) — same destructive-op shape, same
 * batch surfaces, same confirmation gate — on the same resource as
 * `src/commands/comments/edit.ts` (R18).
 *
 * Surfaces:
 *   - Single id positional: `comments delete 4821993 --yes`.
 *   - Multi positional: `comments delete 4821993 4821994 --yes`.
 *   - `--ids "1,2,3"` flag (mutex with positional and `--stdin`).
 *   - `--stdin` NDJSON (mutex with positional and `--ids`).
 *   - `--dry-run` (any input source) — skips the wire call AND the
 *     confirmation prompt (no destructive effect).
 *   - `--yes` — bypasses the confirmation prompt (global flag).
 *
 * There is no `-` stdin sentinel here. In `comments edit` the `-` positional
 * means "read the *content* from stdin"; delete has no content, so `-` has
 * nothing to denote and falls through the ordinary `<id>` parser as invalid.
 *
 * Confirmation policy (spec 0061 §2.3, delegated to `src/lib/confirm.ts`):
 *   - `--yes` → unconditional proceed.
 *   - `--dry-run` → unconditional proceed (no destructive effect).
 *   - TTY without `--yes` → prompt once for the whole run (N comments).
 *     User declines → `ConfirmationError` (exit 2), no wire calls.
 *   - Non-TTY without `--yes` → `ConfirmationError` (exit 2) immediately,
 *     no wire calls, no credential resolution.
 *
 * **Two endpoint-specific error surfaces (spec 0061 §5) — the load-bearing
 * part of this slice:**
 *
 *   - **404 is an error, NOT idempotent success.** R13's `tasks delete`
 *     re-classifies a 404 on DELETE as success-with-`already_in_target_state:
 *     true`. This command deliberately does not. Per yaml :3216 a 404 here
 *     means *either* "no such comment" *or* "you are not its author" — Freelo
 *     returns 404 rather than 403 so inaccessible comments aren't leaked — so
 *     absorbing it would report `exit 0` / "deleted" for a colleague's comment
 *     still sitting in the thread. The message stays a **plain** not-found;
 *     the ACL nuance lives in `hint_next` only, never the message. See
 *     decision 1; pinned by a regression test so a later "let's make the
 *     deletes consistent" refactor fails loudly.
 *   - **400 is rewritten, not passed through.** A 400 means the 15-minute
 *     post-time deletion window expired (yaml :3216-3217 — the endpoint's only
 *     documented 400 cause). The generic `Freelo API error (HTTP 400).` is a
 *     dead end, so message + hint name the rule and point at `comments edit`,
 *     which the yaml notes has no time limit. `code` / `exitCode` / `errors[]`
 *     are preserved (decision 2).
 *
 * Output schema: `freelo.comments.delete/v1`.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  deleteComment,
  deleteCommentPath,
  type DeleteCommentResult,
} from '../../api/comments-delete.js';
import { type CommentsDeleteData } from '../../api/schemas/comment.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderCommentsDeleteHuman } from '../../ui/human/comments-delete.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import { confirmDestructive } from '../../lib/confirm.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.comments.delete/v1',
  destructive: true,
};

const SCHEMA: SchemaString = 'freelo.comments.delete/v1';

type DeleteOpts = {
  ids?: string;
  stdin?: true;
  dryRun?: true;
};

/* ---------------------------------------------------------------------------
 *  Per-line NDJSON schema (--stdin batch mode). Byte-identical to R13's —
 *  only `id` is required, no extra keys allowed so typos surface early.
 * ------------------------------------------------------------------------- */

const BatchLineSchema = z
  .object({
    id: z.number().int('id must be an integer (no string-form).').positive('id must be ≥ 1.'),
  })
  .strict();

/* ---------------------------------------------------------------------------
 *  Input parsing (Commander parsers throw `ValidationError` (BaseError, exit
 *  2) — NOT Commander's `InvalidArgumentError` which would map to exit 1.
 *  Calibration §1-2.
 * ------------------------------------------------------------------------- */

function parsePositiveInt(label: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`${label} must be a positive integer.`, {
      hintNext: `${label} is the numeric comment id (from \`freelo comments list\`).`,
    });
  }
  return n;
}

/**
 * Variadic `<id>...` collector. Commander invokes this once per token; bad
 * tokens surface as `ValidationError` at parse time.
 */
function collectCommentId(raw: string, prev: number[] | undefined): number[] {
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
      hintNext: '--ids takes a comma- or space-separated list of numeric comment ids.',
    });
  }
  return tokens.map((t) => parsePositiveInt('--ids', t));
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerDelete(
  comments: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = comments
    .command('delete')
    .description(
      'Delete one or more comments. Destructive — requires --yes (non-TTY) or interactive confirmation (TTY). Only the comment author can delete, and only within 15 minutes of posting; after that the API refuses and `comments edit` is the workaround. Unlike `tasks delete`, a 404 is reported as an error, not as an idempotent already-deleted success.',
    )
    .argument('[id...]', 'One or more numeric comment ids (positional).', collectCommentId)
    .option(
      '--ids <list>',
      'Comma- or space-separated list of comment ids (mutex with positional <id> and --stdin).',
    )
    .option(
      '--stdin',
      'Read NDJSON from stdin (one `{"id": <int>}` per line). Mutex with positional and --ids.',
    )
    .option(
      '--dry-run',
      'Skip the DELETE per id. No confirmation prompt fires. Envelope reflects what *would* have been called.',
    );
  // NOTE: `--yes` / `-y` is the **global** flag (registered on the root
  // program in `src/bin/freelo.ts`). Commander binds it to the root program's
  // opts, not the subcommand's — we read it via `resolveYesFlag(cmd)` below.
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
        // No ids resolved from any source → silent success (matches R09/R11/R13
        // batch convention; spec 0061 §2.2).
        return;
      }

      await runIdList(resolvedIds, opts, yes, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/**
 * Walk the Commander tree up to the root program and read the global `--yes`
 * (`-y`) flag. Mirrors `src/commands/tasks/delete.ts` — the flag is registered
 * on the root program, so subcommand opts do NOT carry it.
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
 *  Cross-source validation (mirrors R13)
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
    throw new ValidationError('No comment ids supplied.', {
      hintNext: 'Pass numeric ids positionally, or use --ids "a,b,c", or pipe NDJSON to --stdin.',
    });
  }
}

/* ---------------------------------------------------------------------------
 *  Batch from positional / --ids
 *
 *  Confirmation fires once for the whole run (spec 0061 §2.3). Single-mode
 *  error semantics mirror R11/R13: errors bubble for one-id runs, per-id
 *  envelopes for multi-id runs.
 * ------------------------------------------------------------------------- */

async function runIdList(
  ids: readonly number[],
  opts: DeleteOpts,
  yes: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;

  // 1. Confirmation gate (once for the whole run).
  await confirmDestructive({
    promptMessage: confirmMessage(ids.length),
    yes,
    dryRun: opts.dryRun === true,
  });

  // 2. Dry-run never resolves credentials — there is no wire call to
  //    authenticate. Mirrors `comments edit`'s null-client dry-run path.
  const client = opts.dryRun === true ? null : await buildClient(appConfig, env);

  if (ids.length === 1) {
    // Single-id mode: errors bubble to the top-level handler so the agent
    // sees ONE envelope on stderr (matches R11/R12/R13 single-mode contract).
    await runOneId(ids[0]!, opts, appConfig, client, /* lineIndex */ undefined);
    return;
  }

  // Multi-id mode: per-id error envelopes go to stdout (the success stream)
  // and the highest exit code wins at end-of-loop. Same shape as R11/R13.
  const exitAcc = new ExitCodeAccumulator();
  for (let i = 0; i < ids.length; i += 1) {
    const commentId = ids[i]!;
    try {
      await runOneId(commentId, opts, appConfig, client, /* lineIndex */ undefined);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, commentId, mode, /* fromStdin */ false);
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
 *  Mirrors R11/R13: buffer stdin → confirm once → per-line parse + run
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
    // Empty stdin → silent success exit 0 (matches R09/R11/R13; spec 0061 §2.2).
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
  // credential resolution (mirrors R09/R11/R13).
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
      writeBatchError(result.error, i, /* commentIdMaybe */ null, mode, /* fromStdin */ true);
      exitAcc.observe(result.error.exitCode);
      continue;
    }
    const commentId = result.value.id;
    try {
      const client = opts.dryRun === true ? null : await getClient();
      await runOneId(commentId, opts, appConfig, client, /* lineIndex */ i);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, commentId, mode, /* fromStdin */ true);
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
 *  Per-id flow — dry-run / DELETE
 *
 *  Spec 0061 §5.1: no 404 absorption, no pre-check GET. The DELETE response
 *  is the source of truth and a failure stays a failure.
 * ------------------------------------------------------------------------- */

async function runOneId(
  commentId: number,
  opts: DeleteOpts,
  appConfig: PartialAppConfig,
  client: HttpClient | null,
  lineIndex: number | undefined,
): Promise<void> {
  const mode = appConfig.output.mode;

  // ---- 1. Dry-run: skip the DELETE, emit envelope with `would`.
  if (opts.dryRun === true) {
    const data: CommentsDeleteData = {
      comment_id: commentId,
      current_state: 'deleted',
      already_in_target_state: false,
      would: {
        method: 'DELETE',
        path: deleteCommentPath(commentId),
        body: {},
      },
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope: Envelope<CommentsDeleteData> = {
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

  let result: DeleteCommentResult;
  try {
    result = await deleteComment(client, commentId, {
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    // No 404 re-classification here — see the file header and spec 0061 §5.1.
    // The rewriter only improves message/hint; it never converts an error into
    // a success.
    throw rewriteDeleteCommentError(err, commentId);
  }

  const data: CommentsDeleteData = {
    comment_id: commentId,
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
 *  Endpoint-specific error rewriting (spec 0061 §5.1 / §5.2)
 * ------------------------------------------------------------------------- */

/**
 * Rewrite the two `DELETE /comment/{id}` failures the OpenAPI documents
 * explicitly. Everything else passes through untouched.
 *
 * **400** — the endpoint's only documented 400 cause is the expired 15-minute
 * deletion window (yaml :3216-3217). The generic `Freelo API error (HTTP 400).`
 * tells a user nothing, so both the message and the hint name the rule, and
 * the hint points at `comments edit` — which the yaml notes has *no* time
 * limit and is therefore the real workaround. The server's own `errors[]`
 * still rides along on the envelope, so if Freelo ever adds a second 400 cause
 * the raw text stays visible.
 *
 * **404** — kept a **plain** not-found (decision 1). The message never says
 * "forbidden" or "permission"; the ACL nuance (Freelo returns 404 rather than
 * 403 so inaccessible comments aren't leaked, making the two causes
 * indistinguishable) lives only in `hint_next`.
 *
 * `code`, `exitCode`, `retryable`, `errors`, `httpStatus` and `requestId` are
 * preserved in both cases — this is presentation, not reclassification
 * (decision 2: no new `FreeloApiErrorCode` member).
 */
function rewriteDeleteCommentError(err: unknown, commentId: number): unknown {
  if (!(err instanceof FreeloApiError)) return err;

  if (err.httpStatus === 400) {
    return new FreeloApiError(
      `Comment ${commentId} can no longer be deleted — Freelo's 15-minute deletion window since the comment was posted has expired.`,
      err.code,
      {
        httpStatus: err.httpStatus,
        errors: err.errors,
        rawBody: err.rawBody,
        hintNext: `Freelo only allows a comment to be deleted within 15 minutes of posting (docs/api/freelo-api.yaml :3216-3217). Editing has no time limit — use \`freelo comments edit ${commentId} --message "…"\` to redact the content instead.`,
        ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      },
    );
  }

  if (err.httpStatus === 404) {
    return new FreeloApiError(`Comment ${commentId} not found.`, err.code, {
      httpStatus: err.httpStatus,
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: `It may not exist, or you may not be its author — Freelo returns 404 rather than 403 for comments you cannot access, so the two cases are indistinguishable from the API (docs/api/freelo-api.yaml :3215). Only a comment's own author can delete it.`,
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
 */
function confirmMessage(count: number): string {
  if (count === 1) return 'Delete 1 comment?';
  return `Delete ${count} comments?`;
}

function writeEnvelope(
  envelope: Envelope<CommentsDeleteData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const line = renderCommentsDeleteHuman(envelope.data);
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Per-id error envelope writer for batch mode. Mirrors R13's shape:
 * `freelo.error/v1` augmented with `context.line_index` (stdin) or
 * `context.input_index` (positional / --ids), plus `context.comment_id` when
 * a line parsed.
 *
 * Calibration §4: covered by tests (mixed-batch rows).
 */
function writeBatchError(
  err: BaseError,
  index: number,
  commentIdMaybe: number | null,
  mode: 'human' | 'json' | 'ndjson',
  fromStdin: boolean,
): void {
  if (mode === 'human') {
    const idPart = commentIdMaybe === null ? '' : ` (comment #${commentIdMaybe})`;
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
  if (commentIdMaybe !== null) context['comment_id'] = commentIdMaybe;
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
 * Coerce an unknown thrown value into a `BaseError`. Mirrors R11/R13. Any
 * throw that isn't already a `BaseError` (defensive — e.g. a programming bug
 * surfacing as a plain `Error`) maps to `VALIDATION_ERROR` (exit 2).
 */
function toBaseError(err: unknown): BaseError {
  if (err instanceof BaseError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ValidationError(message, {
    hintNext: 'Investigate the underlying error and retry the id.',
  });
}
