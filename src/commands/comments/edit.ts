/**
 * `freelo comments edit <id>...` (R18, spec 0029).
 *
 * Overwrite the content of one or more existing comments via
 * `POST /comment/{comment_id}` (yaml :2619-2663, `editComment`).
 *
 * Surfaces:
 *
 *   - Single id positional: `comments edit 1234567 --message <str>`
 *   - Variadic positional: `comments edit 1234567 1234568 --message <str>`
 *   - `--ids "1,2,3"` flag (mutex with positional and `--stdin`).
 *   - `--stdin` NDJSON (mutex with positional and `--ids`); each line carries
 *     its own `{id, content}` (varied content per row).
 *   - `--dry-run` — skips every POST; envelope echoes the would-be body.
 *
 * Content sources (mutex; non-stdin paths only — `--stdin` owns content per
 * row):
 *
 *   - `--message <str>` — inline pass-through (no I/O).
 *   - `--from-file <path>` — UTF-8 file read (delegates to `src/lib/input.ts`).
 *   - `--editor`         — spawn $VISUAL/$EDITOR (TTY-only; delegates).
 *   - `-`                — read stdin to EOF (single id only — see decision 1).
 *
 * Empty content is rejected at the command layer (spec 0029 §3.4 / decision 3).
 *
 * Edit is **non-destructive** — no `--yes` interaction, no confirmation
 * helper. Edit is **not** absorbing-state — no `already_in_target_state`
 * field, no idempotency helper.
 *
 * Output schema: `freelo.comments.edit/v1`.
 *
 * Spec 0029 §3.
 */

import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  buildEditCommentBody,
  editComment,
  editCommentPath,
  type EditCommentResult,
} from '../../api/comments.js';
import { type CommentsEditData, type EditCommentSource } from '../../api/schemas/comment.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { readInput, type InputSource } from '../../lib/input.js';
import { renderCommentsEditHuman } from '../../ui/human/comments-edit.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.comments.edit/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.comments.edit/v1';

type EditOpts = {
  message?: string;
  fromFile?: string;
  editor?: boolean;
  ids?: string;
  stdin?: true;
  dryRun?: true;
};

/* ---------------------------------------------------------------------------
 *  NDJSON row schema (--stdin batch mode).
 *
 *  Each line is `{"id": <positive int>, "content": <non-empty string>}`.
 *  Strict: extra keys are rejected so users notice typos early.
 *
 *  Spec 0029 §3.4 / decision 2.
 * ------------------------------------------------------------------------- */

const BatchLineSchema = z
  .object({
    id: z.number().int('id must be an integer (no string-form).').positive('id must be ≥ 1.'),
    content: z.string().min(1, 'content must be a non-empty string.'),
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
 * Variadic `<id>...` collector. Commander invokes this once per token.
 *
 * Special case: the literal `-` is the **stdin sentinel** (single id mode).
 * It must be the only positional value when present, and it is mutually
 * exclusive with batch over multiple ids (decision 1). The collector
 * returns a `'-'` marker; the action validates batch vs. single-stdin
 * combinations after parse.
 */
function collectIdOrStdin(
  raw: string,
  prev: ReadonlyArray<number | '-'> | undefined,
): Array<number | '-'> {
  const next = raw === '-' ? '-' : parsePositiveInt('<id>', raw);
  return prev ? [...prev, next] : [next];
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

export function registerEdit(
  comments: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = comments
    .command('edit')
    .description(
      "Overwrite an existing comment's content. Single id or batch (positional <id>..., --ids, or --stdin NDJSON). Content from --message, --from-file, --editor, or stdin (-). Endpoint is POST /comment/{id} (yaml :2634 — POST for historical reasons).",
    )
    .argument(
      '[id...]',
      "One or more numeric comment ids, or the literal '-' (stdin sentinel; single-id only).",
      collectIdOrStdin,
    )
    .option('--message <str>', 'Inline content. Mutex with --from-file, --editor, and `-`.')
    .option(
      '--from-file <path>',
      'Read content from a UTF-8 file. Mutex with --message, --editor, and `-`.',
    )
    .option(
      '--editor',
      'Open $VISUAL/$EDITOR (or platform default) to edit content interactively. Requires a TTY. Mutex with the other content sources.',
    )
    .option(
      '--ids <list>',
      'Comma- or space-separated list of comment ids (mutex with positional <id> and --stdin).',
    )
    .option(
      '--stdin',
      'Read NDJSON from stdin (one `{"id": <int>, "content": <str>}` per line). Mutex with positional and --ids; mutex with --message/--from-file/--editor (NDJSON owns per-row content).',
    )
    .option('--dry-run', 'Skip every POST; envelopes echo the body that would have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (idsRaw: ReadonlyArray<number | '-'> | undefined, opts: EditOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      const inputs = validateInputSources(idsRaw, opts);

      if (inputs.kind === 'stdin') {
        await runBatchFromStdin(opts, appConfig, env);
        return;
      }

      // For single-id and shared-content batch, content is one of message/file/editor/stdin.
      const { content, source } = await resolveSharedContent(inputs.containsDash, opts, env);

      // Empty content is rejected at the command layer (spec 0029 decision 3).
      if (content.length === 0) {
        throw new ValidationError('Comment content is empty; refusing to edit.', {
          hintNext: 'Pass non-empty content via --message, --from-file, --editor, or stdin (-).',
        });
      }

      const ids = inputs.ids;
      if (ids.length === 0) {
        // No ids at all → silent success exit 0 (matches batch convention).
        return;
      }

      if (ids.length === 1) {
        // Single-id: errors bubble to top-level handler (one envelope on stderr).
        const client = opts.dryRun === true ? null : await buildClient(appConfig, env);
        await runOneId(ids[0]!, content, source, opts, appConfig, client, undefined);
        return;
      }

      // Multi-id: per-id envelopes go to stdout, highest-of exit code wins.
      const client = opts.dryRun === true ? null : await buildClient(appConfig, env);
      const exitAcc = new ExitCodeAccumulator();
      for (let i = 0; i < ids.length; i += 1) {
        const commentId = ids[i]!;
        try {
          await runOneId(commentId, content, source, opts, appConfig, client, undefined);
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
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Cross-source validation
 * ------------------------------------------------------------------------- */

type ValidatedInputs =
  | { kind: 'stdin' }
  | { kind: 'positional'; ids: number[]; containsDash: boolean };

/**
 * Validate the input-source matrix and return the resolved id list (or a
 * stdin-mode marker). Throws `ValidationError` (exit 2) on any combination
 * the spec rejects.
 *
 * Mutex rules (spec 0029 §2.2):
 *   - Exactly one of {positional <id>..., --ids, --stdin}.
 *   - When `--stdin`: `--message` / `--from-file` / `--editor` and `-`
 *     positional are all rejected (NDJSON owns content per row).
 *   - When positional contains `-`: ids count must be exactly 1 (decision 1).
 *   - When `--ids` is used: `-` cannot appear elsewhere as a content source
 *     (single-id-only rule).
 */
function validateInputSources(
  idsRaw: ReadonlyArray<number | '-'> | undefined,
  opts: EditOpts,
): ValidatedInputs {
  const positional = idsRaw ?? [];
  const hasPositional = positional.length > 0;
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

  if (hasStdin) {
    // NDJSON owns per-row content. Reject any shared-content source.
    if (opts.message !== undefined || opts.fromFile !== undefined || opts.editor === true) {
      throw new ValidationError(
        '--stdin owns per-row content (each NDJSON line carries its own `content`); --message, --from-file, and --editor are not allowed with --stdin.',
        {
          hintNext:
            'Either pass content per NDJSON row, or drop --stdin and use --ids "a,b,c" with --message/--from-file/--editor for shared content.',
        },
      );
    }
    return { kind: 'stdin' };
  }

  if (hasIdsFlag) {
    // --ids: ids parsed from the flag; no `-` involvement possible.
    const ids = parseIdsFlag(opts.ids!);
    return { kind: 'positional', ids, containsDash: false };
  }

  // Positional path. May contain a `-` sentinel.
  const containsDash = positional.some((v): v is '-' => v === '-');
  const numericIds = positional.filter((v): v is number => typeof v === 'number');

  if (containsDash && numericIds.length === 0) {
    // `-` alone is invalid: it means "read stdin content" but no id was provided.
    throw new ValidationError(
      "The literal '-' is the stdin-content sentinel; it must be combined with exactly one numeric <id>.",
      {
        hintNext:
          "Pass a single numeric comment id followed by '-' (e.g. `comments edit 1234567 -`).",
      },
    );
  }

  if (containsDash && numericIds.length > 1) {
    // Decision 1: `-` is rejected when batch (>1 id) is in play.
    throw new ValidationError(
      "The literal '-' (stdin content) cannot be combined with multiple ids; it is single-id only.",
      {
        hintNext:
          'For batch edits, use --message / --from-file / --editor for shared content, or pipe NDJSON to --stdin for per-row content.',
      },
    );
  }

  return { kind: 'positional', ids: numericIds, containsDash };
}

/* ---------------------------------------------------------------------------
 *  Shared-content resolution (single id or shared-content batch)
 * ------------------------------------------------------------------------- */

/**
 * Resolve the shared content from one of the four sources. Throws
 * `ValidationError` if zero or more-than-one source is specified.
 *
 * `containsDash`: from `validateInputSources` — when true, `-` was already
 * present in the positional list and we must read stdin (mutex enforcement
 * still applies to `--message`/`--from-file`/`--editor`).
 */
async function resolveSharedContent(
  containsDash: boolean,
  opts: EditOpts,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ content: string; source: EditCommentSource }> {
  const hasMessage = opts.message !== undefined;
  const hasStdin = containsDash;
  const hasFile = opts.fromFile !== undefined;
  const hasEditor = opts.editor === true;

  const count = (hasMessage ? 1 : 0) + (hasStdin ? 1 : 0) + (hasFile ? 1 : 0) + (hasEditor ? 1 : 0);
  if (count === 0) {
    throw new ValidationError(
      'Specify exactly one content source: --message <str>, --from-file <path>, --editor, or - (stdin).',
      {
        hintNext:
          "Pick a source: --message <str> for inline, --from-file <path> for a file, --editor for an interactive editor, or '-' to read stdin.",
      },
    );
  }
  if (count > 1) {
    throw new ValidationError('Specify exactly one content source, not multiple.', {
      hintNext: "Pick one of --message, --from-file, --editor, or '-' (stdin).",
    });
  }

  if (hasMessage) {
    return { content: opts.message ?? '', source: 'message' };
  }

  let inputSource: InputSource;
  if (hasFile) {
    inputSource = { kind: 'file', path: opts.fromFile! };
  } else if (hasEditor) {
    inputSource = { kind: 'editor' };
  } else {
    inputSource = { kind: 'stdin' };
  }

  const result = await readInput(inputSource, { env });
  return { content: result.content, source: result.source };
}

/* ---------------------------------------------------------------------------
 *  Batch from --stdin (NDJSON)
 * ------------------------------------------------------------------------- */

async function runBatchFromStdin(
  opts: EditOpts,
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
    // Empty stdin → silent success exit 0 (matches R09/R11/R13 batch convention).
    return;
  }

  // Lazy client construction — a stdin of all-bad lines never reaches
  // credential resolution (matches R09/R11/R13 lazy-build pattern).
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
      writeBatchError(result.error, i, /* commentIdMaybe */ null, mode, /* fromStdin */ true);
      exitAcc.observe(result.error.exitCode);
      continue;
    }
    const commentId = result.value.id;
    const content = result.value.content;
    try {
      const client = opts.dryRun === true ? null : await getClient();
      await runOneId(commentId, content, 'ndjson', opts, appConfig, client, /* lineIndex */ i);
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
 *  Per-id flow — dry-run / POST live
 *
 *  Spec 0029 §3. No idempotency, no confirmation.
 * ------------------------------------------------------------------------- */

async function runOneId(
  commentId: number,
  content: string,
  source: EditCommentSource,
  opts: EditOpts,
  appConfig: PartialAppConfig,
  client: HttpClient | null,
  lineIndex: number | undefined,
): Promise<void> {
  const mode = appConfig.output.mode;
  const body = buildEditCommentBody({ content });
  const byteLength = Buffer.byteLength(content, 'utf8');

  // ---- Dry-run: skip the POST, emit envelope with `would`.
  if (opts.dryRun === true) {
    const data: CommentsEditData = {
      comment_id: commentId,
      byte_length: byteLength,
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope = dryRunEnvelope({
      schema: SCHEMA,
      data,
      would: { method: 'POST', path: editCommentPath(commentId), body },
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    writeEnvelope(envelope, mode);
    return;
  }

  // ---- Live POST.
  // Defensive: live mode should always have a client; throw if not (caller bug).
  if (client === null) {
    throw new ValidationError('Internal: HTTP client missing for live edit.', {
      hintNext: 'This is a programming bug — please file an issue.',
    });
  }

  let result: EditCommentResult;
  try {
    result = await editComment(client, {
      commentId,
      body,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    throw rewriteEditCommentHint(err, commentId);
  }

  const data: CommentsEditData = {
    comment_id: commentId,
    comment: result.comment,
    source,
    byte_length: byteLength,
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
  envelope: Envelope<CommentsEditData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const line = renderCommentsEditHuman(envelope.data);
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Per-id error envelope writer for batch mode. Mirrors R13's `writeBatchError`
 * shape: `freelo.error/v1` augmented with `context.line_index` (stdin) or
 * `context.input_index` (positional / --ids), plus `context.comment_id` when
 * a line parsed.
 *
 * Calibration §4: covered by tests (mixed-batch test rows).
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
 * Coerce an unknown thrown value into a `BaseError`. Mirrors R13's `toBaseError`.
 * Defensive: any non-`BaseError` throw is mapped to `VALIDATION_ERROR` (exit 2).
 */
function toBaseError(err: unknown): BaseError {
  if (err instanceof BaseError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ValidationError(message, {
    hintNext: 'Investigate the underlying error and retry the id.',
  });
}

/**
 * Hint rewriter for `editComment` failures. Per yaml :2631-2633, ACL
 * violations on edit return 404 (not 403) to avoid leaking comment
 * existence — so the 404 hint names BOTH possible causes. 403 is
 * defensive; we keep a generic permission hint there too.
 */
function rewriteEditCommentHint(err: unknown, commentId: number): unknown {
  if (!(err instanceof FreeloApiError) || (err.httpStatus !== 404 && err.httpStatus !== 403)) {
    return err;
  }
  const hintNext =
    err.httpStatus === 404
      ? `Comment ${commentId} not found, or your account does not have permission to edit it (per Freelo OpenAPI yaml :2631-2633, ACL failures on edit return 404, not 403, to avoid leaking comment existence).`
      : `Account does not have permission to edit comment ${commentId}.`;
  return new FreeloApiError(err.message, err.code, {
    httpStatus: err.httpStatus,
    errors: err.errors,
    rawBody: err.rawBody,
    hintNext,
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
  });
}
