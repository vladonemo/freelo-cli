/**
 * `freelo comments add --task <id> (--message <str> | --from-file <path> | --editor | -)`
 * (R17, spec 0028).
 *
 * Posts a single comment to a task. Content comes from one of four sources,
 * exactly-one-required:
 *
 *   - `--message <str>` — inline pass-through (no I/O).
 *   - `--from-file <path>` — UTF-8 file read (delegates to `src/lib/input.ts`).
 *   - `--editor`            — spawn $VISUAL/$EDITOR (TTY-only; delegates).
 *   - `-`                   — read stdin to EOF (delegates).
 *
 * Empty content is rejected at the command layer (spec 0028 §3.1 / decision 1).
 *
 * Note on server-side behavior: when the target task has no prior comments,
 * the API auto-flips this POST to a task description (yaml :2589-2592). The
 * CLI surfaces this via `data.is_description: true` and a human-mode hint
 * pointing at `freelo tasks description set` for explicit writes.
 *
 * Idempotency is **N/A**: each POST creates a new comment row server-side.
 * No client-side dedupe (see spec 0028 §6).
 *
 * Output schema: `freelo.comments.add/v1`.
 *
 * Spec 0028 §3.
 */

import { Buffer } from 'node:buffer';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import {
  addComment,
  addCommentPath,
  buildAddCommentBody,
  type AddCommentResult,
} from '../../api/comments.js';
import { type CommentsAddData, type AddCommentSource } from '../../api/schemas/comment.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { readInput, type InputSource } from '../../lib/input.js';
import { render } from '../../ui/render.js';
import { renderCommentsAddHuman } from '../../ui/human/comments-add.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.comments.add/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.comments.add/v1';

type AddOpts = {
  task?: number;
  message?: string;
  fromFile?: string;
  editor?: boolean;
  dryRun?: boolean;
};

/**
 * Parse the `--task` value. Throws `ValidationError` (BaseError, exit 2) —
 * NOT Commander's `InvalidArgumentError` which would map to exit 1
 * (Calibration §1-2).
 */
function parseTaskFlag(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--task must be a positive integer.', {
      hintNext: '--task is the numeric task id from `freelo tasks list`.',
    });
  }
  return n;
}

/**
 * Parse the optional `<input>` positional. Only legal value is the literal
 * `-` (meaning "read from stdin"). Anything else → `ValidationError`.
 *
 * Mirrors R15's `parseStdinSentinel` (spec 0026 §3.3).
 */
function parseStdinSentinel(raw: string): '-' {
  if (raw !== '-') {
    throw new ValidationError(`Unexpected positional '${raw}'.`, {
      hintNext:
        "The only legal positional is '-' (read from stdin). Use --message <str>, --from-file <path>, or --editor for other sources.",
    });
  }
  return '-';
}

export function registerAdd(
  comments: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = comments
    .command('add')
    .description(
      'Post a single comment to a task from --message, --from-file, --editor, or stdin (-). Note: when the target task has no prior comments, the API converts this into the task description; use `freelo tasks description set` for explicit description writes.',
    )
    .argument(
      '[input]',
      "Input source sentinel: pass '-' to read content from stdin.",
      parseStdinSentinel,
    )
    // NOTE: declared as `option` (not `requiredOption`) because Commander's
    // built-in required-option failure exits with code 1 via its own error
    // class. We need exit 2 (`ValidationError`) per the exit-code contract
    // (Calibration §1-2) — handled in the action below.
    .option('--task <id>', 'Target task id (positive integer).', parseTaskFlag)
    .option('--message <str>', 'Inline comment content. Mutex with --from-file, --editor, and `-`.')
    .option(
      '--from-file <path>',
      'Read comment content from a UTF-8 file. Mutex with --message, --editor, and `-`.',
    )
    .option(
      '--editor',
      'Open $VISUAL/$EDITOR (or platform default) to edit content interactively. Requires a TTY.',
    )
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (input: '-' | undefined, opts: AddOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // `--task` is `requiredOption` so Commander guarantees `opts.task` is
      // set; the parser already validated it. Defensive read for type
      // narrowing.
      if (opts.task === undefined) {
        throw new ValidationError('--task is required.', {
          hintNext: '--task is the numeric task id from `freelo tasks list`.',
        });
      }
      const taskId = opts.task;

      // Resolve which source to read from given the user's flag selection.
      // Throws `ValidationError` (exit 2) on zero or more-than-one sources.
      const { content, source } = await resolveContent(input, opts, env);

      // Empty content is rejected at the command layer (spec 0028 decision 1).
      if (content.length === 0) {
        throw new ValidationError('Comment content is empty; refusing to post.', {
          hintNext: 'Pass non-empty content via --message, --from-file, --editor, or stdin (-).',
        });
      }

      const body = buildAddCommentBody({ content });
      const byteLength = Buffer.byteLength(content, 'utf8');

      // --- Dry-run: no HTTP, no credential resolution.
      if (opts.dryRun === true) {
        const data: CommentsAddData = {
          task_id: taskId,
          byte_length: byteLength,
        };
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data,
          would: { method: 'POST', path: addCommentPath(taskId), body },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        render(mode, envelope, (d) => renderCommentsAddHuman(d));
        return;
      }

      // --- Live POST.
      const creds = await resolveCredentials({
        profile: appConfig.profile,
        apiBaseUrl: appConfig.apiBaseUrl,
        env,
      });
      const client = createHttpClient({
        email: creds.email,
        apiKey: creds.apiKey,
        apiBaseUrl: creds.apiBaseUrl,
        userAgent: appConfig.userAgent,
      });

      let result: AddCommentResult;
      try {
        result = await addComment(client, {
          taskId,
          body,
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
      } catch (err: unknown) {
        throw rewriteAddCommentHint(err, taskId);
      }

      // Pull `is_description` up to a stable, always-present boolean (spec
      // 0028 decision 3). Server may return null/undefined; we coerce to
      // `false` so agents can branch without checking key presence.
      const isDescription = result.comment.is_description === true ? true : false;

      const data: CommentsAddData = {
        task_id: taskId,
        comment: result.comment,
        source,
        byte_length: byteLength,
        is_description: isDescription,
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
      render(mode, envelope, (d) => renderCommentsAddHuman(d));
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/**
 * Resolve which source to read from given the user's flag selection. Returns
 * the content + a stable `source` enum. Throws `ValidationError` if zero or
 * more-than-one sources are specified, or if `--message ''` is empty (the
 * inline-source layer applies the same emptiness check as the I/O sources;
 * a final check after this function catches the empty case for ALL sources).
 *
 * Spec 0028 §3.1 / decision 5.
 */
async function resolveContent(
  input: '-' | undefined,
  opts: AddOpts,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ content: string; source: AddCommentSource }> {
  const hasMessage = opts.message !== undefined;
  const hasStdin = input === '-';
  const hasFile = opts.fromFile !== undefined;
  const hasEditor = opts.editor === true;

  const count = (hasMessage ? 1 : 0) + (hasStdin ? 1 : 0) + (hasFile ? 1 : 0) + (hasEditor ? 1 : 0);
  if (count === 0) {
    throw new ValidationError(
      'Specify exactly one of --message <str>, --from-file <path>, --editor, or - (stdin).',
      {
        hintNext:
          "Pick a source: --message <str> for inline, --from-file <path> for a file, --editor for an interactive editor, or '-' to read stdin.",
      },
    );
  }
  if (count > 1) {
    throw new ValidationError('Specify exactly one input source, not multiple.', {
      hintNext: "Pick one of --message, --from-file, --editor, or '-' (stdin).",
    });
  }

  if (hasMessage) {
    // Inline pass-through — no `src/lib/input.ts` round-trip (decision 5).
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

  // Read content from the chosen I/O source. Errors are typed
  // `ValidationError` (exit 2) per `src/lib/input.ts`.
  const result = await readInput(inputSource, { env });
  return { content: result.content, source: result.source };
}

/**
 * Hint rewriter for `addComment` failures. Mirrors R15's `rewriteSetHint`:
 * 404 (task missing) and 403 (no access) get resource-specific copy. Other
 * statuses pass through unchanged.
 */
function rewriteAddCommentHint(err: unknown, taskId: number): unknown {
  if (!(err instanceof FreeloApiError) || (err.httpStatus !== 404 && err.httpStatus !== 403)) {
    return err;
  }
  const hintNext =
    err.httpStatus === 404
      ? `Task ${taskId} not found, or your account does not have access to it.`
      : `Account does not have permission to add comments to task ${taskId}.`;
  return new FreeloApiError(err.message, err.code, {
    httpStatus: err.httpStatus,
    errors: err.errors,
    rawBody: err.rawBody,
    hintNext,
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
  });
}
