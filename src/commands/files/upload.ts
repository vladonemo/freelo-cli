/**
 * `freelo files upload <path>... [--attach-to-task <id>] [--message <str>] [--dry-run] [--no-spinner]`
 * (R25, spec 0037).
 *
 * First multipart command in the CLI. Pipeline:
 *   1. Validate every <path> locally (existence, regular file, ≤100 MB).
 *   2. Optionally short-circuit on `--dry-run`.
 *   3. Loop sequentially over paths; per file:
 *      - `buildFileMultipart` → `uploadFile` → push to `uploaded[]` or `failed[]`.
 *      - Lazy `ora` spinner on TTY (decision 04 / Calibration #7).
 *   4. If `--attach-to-task` is set AND ≥1 upload succeeded, build a
 *      comment containing `<a data-freelo-uuid="UUID">name</a>` anchors
 *      (yaml :3876 — the only documented attach mechanism) and POST to
 *      `/task/{id}/comments`.
 *   5. Emit `freelo.files.upload/v1` envelope. Exit 4 on any failure.
 *
 * Exit codes:
 *   - all uploads + (optional) comment OK → 0
 *   - some uploads failed, ≥1 OK → 4 (envelope still includes uploaded[])
 *   - zero uploads OK → throw the first typed error (single-path semantics)
 *   - validation pre-flight → 2
 *   - comment-create fails → 4 (envelope includes uploaded[] for recovery)
 *
 * Schema: `freelo.files.upload/v1`.
 */

import { resolve as resolvePath } from 'node:path';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { uploadFile, FILE_UPLOAD_PATH } from '../../api/files.js';
import { addComment, addCommentPath } from '../../api/comments.js';
import {
  buildFileMultipart,
  FILE_UPLOAD_FIELD_NAME,
  type MultipartFile,
} from '../../lib/multipart.js';
import {
  type FilesFailedEntry,
  type FilesUploadAttached,
  type FilesUploadData,
  type FilesUploadedEntry,
} from '../../api/schemas/file.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderFilesUploadHuman } from '../../ui/human/files-upload.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { BaseError } from '../../errors/base.js';
import { isInteractive } from '../../lib/env.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.files.upload/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.files.upload/v1';

/** Placeholder UUID echoed in dry-run `would.body` since no real UUID exists. */
const PLACEHOLDER_UUID = '00000000-0000-0000-0000-000000000000';

type UploadOpts = {
  attachToTask?: number;
  message?: string;
  dryRun?: boolean;
  // Commander stores `--no-spinner` as `spinner: false` (negation of an
  // implicit `--spinner` boolean). Default is `true` when the flag is absent.
  spinner?: boolean;
};

/* ---------------------------------------------------------------------------
 *  Input parsers — typed errors per Calibration §2.
 * ------------------------------------------------------------------------- */

function parseTaskIdFlag(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--attach-to-task must be a positive integer.', {
      hintNext: 'Pass the numeric task id from `freelo tasks list`.',
    });
  }
  return n;
}

function parseMessageFlag(raw: string): string {
  if (raw.trim().length === 0) {
    throw new ValidationError('--message must be a non-empty string.', {
      hintNext: 'Either omit --message (we synthesize a default) or pass real text.',
    });
  }
  return raw;
}

/* ---------------------------------------------------------------------------
 *  HTML escaping for filenames spliced into comment content.
 *
 *  Comment content is rendered as HTML in the Freelo UI (yaml :2582). A
 *  malicious filename like `pwn<script>.txt` would otherwise ship XSS into
 *  the workspace. Escape `<>&"'` → entities. Decision 09.
 * ------------------------------------------------------------------------- */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/* ---------------------------------------------------------------------------
 *  Comment content builder
 * ------------------------------------------------------------------------- */

function buildAttachComment(
  message: string | undefined,
  files: ReadonlyArray<{ uuid: string; filename: string }>,
): string {
  const anchors = files
    .map((f) => `<a data-freelo-uuid="${escapeHtml(f.uuid)}">${escapeHtml(f.filename)}</a>`)
    .join(', ');
  const prefix = message !== undefined ? `${message}\n\n` : '';
  return `${prefix}Attached: ${anchors}`;
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerUpload(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = parent
    .command('upload')
    .description(
      'Upload one or more local files to Freelo. Returns a UUID per file. Optionally attach the uploads to a task by posting a comment with embedded references (the only documented attach mechanism — yaml :3876).',
    )
    .argument(
      '<path...>',
      'Local file path(s). Each ≤100 MB. Globs are NOT expanded by the CLI — let the shell expand.',
    )
    .option(
      '--attach-to-task <id>',
      'Numeric task id. After uploads succeed, posts a comment on this task with `<a data-freelo-uuid>` anchors for each uploaded file.',
      parseTaskIdFlag,
    )
    .option(
      '--message <str>',
      'Comment content prefix when --attach-to-task is set. Without this, a default "Attached: …" comment is synthesized.',
      parseMessageFlag,
    )
    .option(
      '--dry-run',
      'Skip every POST. Envelope echoes one `would` per planned upload (and one for the comment, if --attach-to-task is set).',
    )
    .option(
      '--no-spinner',
      'Disable the TTY progress spinner. Auto-disabled in CI / non-TTY / piped output regardless.',
    );
  attachMeta(cmd, meta);

  cmd.action(async (paths: string[], opts: UploadOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // Commander variadic guarantees at least one path (signature `<path...>`
      // is required), but defend against an empty array just in case.
      if (paths.length === 0) {
        throw new ValidationError('At least one <path> is required.', {
          hintNext: 'Pass one or more local file paths.',
        });
      }

      // Resolve to absolute paths once — keeps error messages stable and
      // the envelope echoes the user's input verbatim (path, not absPath).
      const resolved = paths.map((p) => ({ input: p, abs: resolvePath(p) }));

      if (opts.dryRun === true) {
        await emitDryRun(resolved, opts, appConfig);
        return;
      }

      await runLive(resolved, opts, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Dry-run flow
 *
 *  Validates every path locally (so the dry-run still catches missing files
 *  / oversize early) but skips the network. Builds one `would` per path and,
 *  when `--attach-to-task` is set, appends a comment-create `would`.
 * ------------------------------------------------------------------------- */

/** Local `Would` shape — narrower than `src/lib/dry-run.ts` because every
 *  POST in this slice is literally `POST` (matches the schema constraint
 *  on `freelo.files.upload/v1.data.would[].method`). */
type FileWould = { method: 'POST'; path: string; body: unknown };

async function emitDryRun(
  resolved: ReadonlyArray<{ input: string; abs: string }>,
  opts: UploadOpts,
  appConfig: PartialAppConfig,
): Promise<void> {
  const mode = appConfig.output.mode;
  const wouldList: FileWould[] = [];

  // Pre-validate every path so dry-run still catches local errors.
  // We don't need to read the bytes for dry-run — just stat. But the helper
  // does both read + stat in one pass. That's fine for dry-run UX (a 100 MB
  // file is a one-time cost) and keeps the codepath identical to live.
  // Iterate; first failure throws and aborts.
  const previews: Array<{ filename: string; bytes: number }> = [];
  for (const r of resolved) {
    const mp = await buildFileMultipart(r.abs);
    previews.push({ filename: mp.filename, bytes: mp.bytes });
    wouldList.push({
      method: 'POST',
      path: FILE_UPLOAD_PATH,
      body: { multipart: { [FILE_UPLOAD_FIELD_NAME]: mp.filename, bytes: mp.bytes } },
    });
  }

  if (opts.attachToTask !== undefined) {
    const placeholderFiles = previews.map((p) => ({
      uuid: PLACEHOLDER_UUID,
      filename: p.filename,
    }));
    const content = buildAttachComment(opts.message, placeholderFiles);
    wouldList.push({
      method: 'POST',
      path: addCommentPath(opts.attachToTask),
      body: { content },
    });
  }

  const data: FilesUploadData = {
    uploaded: [],
    failed: [],
    count: { requested: resolved.length, uploaded: 0, failed: 0 },
  };

  // dryRunEnvelope splices a single `would` into data.would. For multi-would
  // we splice directly and use buildEnvelope with dry_run set manually via
  // the dryRunEnvelope helper applied with the first would, then merged.
  // Simpler: build the envelope inline.
  const envelope: Envelope<FilesUploadData & { would: FileWould[] }> = {
    schema: SCHEMA,
    data: { ...data, would: wouldList },
    dry_run: true,
  };
  if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
  render(mode, envelope, (d) => renderFilesUploadHuman(d));
}

/* ---------------------------------------------------------------------------
 *  Live flow — sequential uploads, optional comment.
 * ------------------------------------------------------------------------- */

async function runLive(
  resolved: ReadonlyArray<{ input: string; abs: string }>,
  opts: UploadOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const client = await buildClient(appConfig, env);

  const uploaded: FilesUploadedEntry[] = [];
  const failed: FilesFailedEntry[] = [];
  /** Parallel to `failed[]` — original typed errors for re-throw on
   *  zero-success runs (preserves the original exit code). */
  const failedTyped: BaseError[] = [];
  let lastRateLimit: { remaining: number | null; reset_at: string | null } | undefined;

  // Spinner setup — gate on isInteractive() AND --no-spinner. Lazy-import
  // ora only when we actually start a spinner (Calibration #7 / decision 06).
  const spinnerEnabled = isInteractive() && opts.spinner !== false;
  let spinner: { text: string; start: () => unknown; stop: () => unknown } | undefined;
  if (spinnerEnabled) {
    const { default: ora } = await import('ora');
    spinner = ora({ text: 'Preparing upload…', stream: process.stderr });
  }

  for (const r of resolved) {
    let multipart: MultipartFile;
    try {
      multipart = await buildFileMultipart(r.abs);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      failed.push(toFailedEntry(r.input, typed));
      failedTyped.push(typed);
      continue;
    }

    if (spinner !== undefined) {
      spinner.text = `Uploading ${multipart.filename}…`;
      spinner.start();
    }

    try {
      const result = await uploadFile(client, {
        multipart,
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      uploaded.push({
        path: r.input,
        filename: result.filename,
        bytes: result.bytes,
        uuid: result.uuid,
      });
      lastRateLimit = {
        remaining: result.raw.rateLimit.remaining,
        reset_at: result.raw.rateLimit.resetAt,
      };
      spinner?.stop();
    } catch (err: unknown) {
      spinner?.stop();
      const typed = toBaseError(err);
      failed.push(toFailedEntry(r.input, typed));
      failedTyped.push(typed);
    }
  }

  // Optional attach-to-task: only when ≥1 upload succeeded.
  let attached: FilesUploadAttached | undefined;
  let commentError: BaseError | undefined;
  if (opts.attachToTask !== undefined && uploaded.length > 0) {
    const content = buildAttachComment(
      opts.message,
      uploaded.map((u) => ({ uuid: u.uuid, filename: u.filename })),
    );
    try {
      const result = await addComment(client, {
        taskId: opts.attachToTask,
        body: { content },
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      const commentId = result.comment.id;
      if (typeof commentId === 'number' && commentId > 0) {
        attached = {
          task_id: opts.attachToTask,
          comment_id: commentId,
          file_uuids: uploaded.map((u) => u.uuid),
        };
        lastRateLimit = {
          remaining: result.raw.rateLimit.remaining,
          reset_at: result.raw.rateLimit.resetAt,
        };
      }
      // If the server returned no id, we deliberately don't synthesize one;
      // `attached` stays undefined. The uploads still surface in `uploaded[]`.
    } catch (err: unknown) {
      commentError = toBaseError(err);
    }
  }

  // Build envelope.
  const data: FilesUploadData = {
    uploaded,
    failed,
    count: {
      requested: resolved.length,
      uploaded: uploaded.length,
      failed: failed.length,
    },
    ...(attached !== undefined ? { attached } : {}),
  };

  const envelope: Envelope<FilesUploadData> = buildEnvelope({
    schema: SCHEMA,
    data,
    ...(lastRateLimit !== undefined ? { rateLimit: lastRateLimit } : {}),
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  render(mode, envelope, (d) => renderFilesUploadHuman(d));

  // Exit-code policy (spec 0037 §5.5):
  // - zero uploads succeeded AND failed.length > 0 → throw the first error
  //   so single-path callers see the original typed exit code.
  // - some succeeded, some failed → exit 4 (highest of failure codes).
  // - comment-create errored → exit through the comment error.
  if (commentError !== undefined) {
    throw commentError;
  }
  if (uploaded.length === 0 && failed.length > 0) {
    // Re-throw the original typed error from the first failure so the
    // top-level handler routes to the correct exit code.
    const first = failedTyped[0];
    if (first !== undefined) {
      throw first;
    }
  }
  if (failed.length > 0) {
    // Partial failure with at least one success: exit 4 without throwing
    // (so the envelope already-emitted is the user's signal). Defer the
    // exit so handleTopLevelError isn't reinvoked.
    const { drainDispatcher, exitDeferred } = await import('../../errors/handle.js');
    await drainDispatcher();
    await exitDeferred(4);
  }
}

/* ---------------------------------------------------------------------------
 *  Helpers
 * ------------------------------------------------------------------------- */

function toBaseError(err: unknown): BaseError {
  if (err instanceof BaseError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ValidationError(message, {
    hintNext: 'Investigate the underlying error and retry.',
  });
}

function toFailedEntry(inputPath: string, typed: BaseError): FilesFailedEntry {
  return {
    path: inputPath,
    error: { code: typed.code, message: typed.message },
  };
}

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
