/**
 * `freelo notes create --project <id> --name <str> [--content <str>|--from-file <path>|--editor|-]`
 * (R44, spec 0058).
 *
 * Creates a project-level note via `POST /project/{project_id}/note`
 * (yaml :4563-4599). Content is optional — name-only notes are valid
 * (the wire body omits `content` when no source is supplied).
 *
 * Content sources (mutually exclusive; optional):
 *   - `--content <str>` — inline pass-through (no I/O).
 *   - `--from-file <path>` — UTF-8 file read.
 *   - `--editor`         — spawn $VISUAL/$EDITOR (TTY-only).
 *   - `-`                — read stdin to EOF.
 *
 * Empty content (after trim) and empty `--name` (after trim) are rejected
 * at the command layer (spec 0058 decision 4).
 *
 * Output schema: `freelo.notes.create/v1`.
 */

import { Buffer } from 'node:buffer';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import {
  buildCreateNoteBody,
  createNote,
  createNotePath,
  type CreateNoteResult,
} from '../../api/notes.js';
import { type NotesCreateData, type NoteContentSource } from '../../api/schemas/note.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { readInput, type InputSource } from '../../lib/input.js';
import { render } from '../../ui/render.js';
import { renderNotesCreateHuman } from '../../ui/human/notes-create.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.notes.create/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.notes.create/v1';

type CreateOpts = {
  project?: number;
  name?: string;
  content?: string;
  fromFile?: string;
  editor?: boolean;
  dryRun?: boolean;
};

function parseProjectFlag(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--project must be a positive integer.', {
      hintNext: '--project is the numeric project id from `freelo projects list`.',
    });
  }
  return n;
}

/**
 * Optional positional `[input]` — the only legal value is `-` (stdin
 * sentinel). Mirrors `comments add` parseStdinSentinel.
 */
function parseStdinSentinel(raw: string): '-' {
  if (raw !== '-') {
    throw new ValidationError(`Unexpected positional '${raw}'.`, {
      hintNext:
        "The only legal positional is '-' (read content from stdin). Use --content, --from-file, or --editor for other sources.",
    });
  }
  return '-';
}

export function registerCreate(
  notes: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = notes
    .command('create')
    .description(
      'Create a project-level note. Content is optional — name-only notes are valid. Content can come from --content, --from-file, --editor, or stdin (-).',
    )
    .argument(
      '[input]',
      "Input source sentinel: pass '-' to read content from stdin.",
      parseStdinSentinel,
    )
    .option('--project <id>', 'Target project id (positive integer, required).', parseProjectFlag)
    .option('--name <str>', 'Note title (required).')
    .option('--content <str>', 'Inline content. Mutex with --from-file, --editor, and `-`.')
    .option(
      '--from-file <path>',
      'Read content from a UTF-8 file. Mutex with --content, --editor, and `-`.',
    )
    .option(
      '--editor',
      'Open $VISUAL/$EDITOR (or platform default) to edit content interactively. Requires a TTY.',
    )
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (input: '-' | undefined, opts: CreateOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // ---- Required flag validation
      if (opts.project === undefined) {
        throw new ValidationError('--project is required.', {
          hintNext: '--project is the numeric project id from `freelo projects list`.',
        });
      }
      const projectId = opts.project;

      const name = opts.name;
      if (name === undefined || name.trim().length === 0) {
        throw new ValidationError('--name is required and must be a non-empty string.', {
          hintNext: 'Pass --name "<title>" — Freelo requires a non-empty note title.',
        });
      }

      // ---- Resolve content source (zero or one allowed; multiple → exit 2)
      const { content, source } = await resolveContent(input, opts, env);

      // Empty content (after trim) is rejected — `--content ""` is a footgun.
      // Note: `source === null` (no source flag) is fine — name-only note.
      if (source !== null && content.trim().length === 0) {
        throw new ValidationError('Note content is empty; refusing to create.', {
          hintNext:
            'Pass non-empty content via --content, --from-file, --editor, or stdin (-) — or omit content for a name-only note.',
        });
      }

      const byteLength = source !== null ? Buffer.byteLength(content, 'utf8') : 0;
      const body = buildCreateNoteBody(source !== null ? { name, content } : { name });

      // ---- Dry-run path: skip credentials and HTTP entirely.
      if (opts.dryRun === true) {
        const dryData: NotesCreateData = {
          project_id: projectId,
          byte_length: byteLength,
          source,
        };
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data: dryData,
          would: { method: 'POST', path: createNotePath(projectId), body },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        render(mode, envelope, (d) => renderNotesCreateHuman(d));
        return;
      }

      // ---- Live POST.
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

      let result: CreateNoteResult;
      try {
        result = await createNote(client, projectId, body, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
      } catch (err: unknown) {
        throw rewriteCreateNoteHint(err, projectId);
      }

      const data: NotesCreateData = {
        project_id: projectId,
        note: result.body,
        byte_length: byteLength,
        source,
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
      render(mode, envelope, (d) => renderNotesCreateHuman(d));
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/**
 * Resolve which content source (if any) the user picked. Zero sources is
 * allowed (name-only note); two or more is `ValidationError`.
 */
async function resolveContent(
  input: '-' | undefined,
  opts: CreateOpts,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ content: string; source: NoteContentSource | null }> {
  const hasInline = opts.content !== undefined;
  const hasStdin = input === '-';
  const hasFile = opts.fromFile !== undefined;
  const hasEditor = opts.editor === true;

  const count = (hasInline ? 1 : 0) + (hasStdin ? 1 : 0) + (hasFile ? 1 : 0) + (hasEditor ? 1 : 0);
  if (count === 0) {
    return { content: '', source: null };
  }
  if (count > 1) {
    throw new ValidationError('Specify at most one content source, not multiple.', {
      hintNext:
        "Pick one of --content, --from-file, --editor, or '-' (stdin), or omit them all for a name-only note.",
    });
  }

  if (hasInline) {
    return { content: opts.content ?? '', source: 'message' };
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

/**
 * Hint rewriter for `createNote` failures. 400/403/404 get resource-specific
 * copy. Other statuses pass through unchanged.
 */
function rewriteCreateNoteHint(err: unknown, projectId: number): unknown {
  if (!(err instanceof FreeloApiError)) return err;
  const status = err.httpStatus;
  if (status === 400) {
    return new FreeloApiError(err.message, err.code, {
      httpStatus: status,
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext:
        'Server-side validation rejected the request; verify --name is non-empty and --project is a project you can write to.',
    });
  }
  if (status === 403) {
    return new FreeloApiError(err.message, err.code, {
      httpStatus: status,
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: `Account does not have permission to create notes in project ${projectId}.`,
    });
  }
  if (status === 404) {
    return new FreeloApiError(err.message, err.code, {
      httpStatus: status,
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: `Project ${projectId} not found. Run \`freelo projects list\` for ids.`,
    });
  }
  return err;
}
