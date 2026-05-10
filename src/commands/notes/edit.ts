/**
 * `freelo notes edit <id> [--name <str>] [--content <str>|--from-file <path>|--editor|-]`
 * (R44, spec 0058).
 *
 * Overwrite an existing note's title and/or content via
 * `POST /note/{note_id}` (yaml :4625-4660). Verb is POST per OpenAPI; the
 * roadmap PATCH is incorrect (decision 2).
 *
 * **Wire requires `name`** even on a content-only edit (yaml :4647-4648).
 * When the user passes only `--content` (no `--name`), the CLI issues a
 * transparent `GET /note/{id}` first to fetch the current `name`, then
 * POSTs with `{ name: <fetched>, content: <new> }`. See spec 0058 §2.2 /
 * decision 3.
 *
 * At least one change flag is required (decision 5). Empty `--name` /
 * `--content` (after trim) are rejected at the CLI layer (decision 4 / 6).
 *
 * Single-shot (no batch). Mixed-content batch is out of scope for v1
 * (spec 0058 §2.6).
 *
 * Output schema: `freelo.notes.edit/v1`.
 */

import { Buffer } from 'node:buffer';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  buildEditNoteBody,
  editNote,
  getNote,
  notePath,
  type EditNoteResult,
} from '../../api/notes.js';
import { type NotesEditData, type NoteContentSource } from '../../api/schemas/note.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { readInput, type InputSource } from '../../lib/input.js';
import { render } from '../../ui/render.js';
import { renderNotesEditHuman } from '../../ui/human/notes-edit.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.notes.edit/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.notes.edit/v1';

type EditOpts = {
  name?: string;
  content?: string;
  fromFile?: string;
  editor?: boolean;
  dryRun?: boolean;
};

function parseNoteId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('<id> must be a positive integer.', {
      hintNext: '<id> is the numeric note id.',
    });
  }
  return n;
}

function parseStdinSentinel(raw: string): '-' {
  if (raw !== '-') {
    throw new ValidationError(`Unexpected positional '${raw}'.`, {
      hintNext:
        "The only legal extra positional is '-' (read content from stdin). Use --content, --from-file, or --editor for other sources.",
    });
  }
  return '-';
}

export function registerEdit(
  notes: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = notes
    .command('edit')
    .description(
      "Overwrite a note's title and/or content. At least one of --name / --content / --from-file / --editor / - is required. Endpoint is POST /note/{id} (yaml :4625 — POST for historical reasons, NOT PATCH).",
    )
    .argument('<id>', 'Numeric note id.', parseNoteId)
    .argument(
      '[input]',
      "Optional positional: pass '-' to read content from stdin.",
      parseStdinSentinel,
    )
    .option('--name <str>', 'New title for the note.')
    .option('--content <str>', 'Inline new content. Mutex with --from-file, --editor, and `-`.')
    .option(
      '--from-file <path>',
      'Read new content from a UTF-8 file. Mutex with --content, --editor, and `-`.',
    )
    .option(
      '--editor',
      'Open $VISUAL/$EDITOR (or platform default) to edit content interactively. Requires a TTY.',
    )
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (id: number, input: '-' | undefined, opts: EditOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // ---- At least one change flag required.
      const hasNameFlag = opts.name !== undefined;
      const hasContentSource =
        opts.content !== undefined ||
        opts.fromFile !== undefined ||
        opts.editor === true ||
        input === '-';
      if (!hasNameFlag && !hasContentSource) {
        throw new ValidationError(
          '`notes edit` requires at least one of --name, --content, --from-file, --editor, or - (stdin).',
          {
            hintNext:
              "Pass at least one change flag — e.g. --name '<new>' or --content '<new body>'.",
          },
        );
      }

      // ---- Validate --name (when set): non-empty after trim.
      if (hasNameFlag && (opts.name ?? '').trim().length === 0) {
        throw new ValidationError('--name must be a non-empty string.', {
          hintNext: 'Pass --name "<new title>" with at least one non-whitespace character.',
        });
      }
      const newName = hasNameFlag ? opts.name : undefined;

      // ---- Resolve content source (zero or one allowed).
      const { content, source } = await resolveContent(input, opts, env);

      // Empty content (after trim) on a content-bearing source → reject.
      if (source !== null && content.trim().length === 0) {
        throw new ValidationError('Note content is empty; refusing to edit.', {
          hintNext:
            'Pass non-empty content via --content, --from-file, --editor, or stdin (-) — or omit content and pass --name only.',
        });
      }

      const byteLength = source !== null ? Buffer.byteLength(content, 'utf8') : 0;
      const appliedChanges: NotesEditData['applied_changes'] = {};
      if (newName !== undefined) appliedChanges.name = newName;
      if (source !== null) appliedChanges.content = content;

      // ---- Resolve effective body (`name` is required by the API).
      // Single GET/POST flow:
      //   - If --name was supplied, name = opts.name.
      //   - Else, GET /note/{id} to fetch current name (decision 3).
      // In dry-run mode, we do NOT issue the GET — the dry-run envelope
      // surfaces the user's intent only; `name` in the `would.body` echoes
      // a placeholder that documents the GET-then-POST flow.

      // ---- Dry-run: echo the body shape the live path WOULD send.
      if (opts.dryRun === true) {
        // For dry-run, we use the user-supplied name if present, otherwise
        // a placeholder that flags the GET-then-POST flow.
        const dryName = newName ?? '<existing-name-from-GET>';
        const dryBody = buildEditNoteBody(
          source !== null ? { name: dryName, content } : { name: dryName },
        );
        const dryData: NotesEditData = {
          note_id: id,
          applied_changes: appliedChanges,
          source,
          byte_length: byteLength,
        };
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data: dryData,
          would: { method: 'POST', path: notePath(id), body: dryBody },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        render(mode, envelope, (d) => renderNotesEditHuman(d));
        return;
      }

      // ---- Live: build client and resolve effective name.
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

      const effectiveName = await resolveEffectiveName(client, id, newName, appConfig.requestId);

      const body = buildEditNoteBody(
        source !== null ? { name: effectiveName, content } : { name: effectiveName },
      );

      let result: EditNoteResult;
      try {
        result = await editNote(client, id, body, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
      } catch (err: unknown) {
        throw rewriteEditNoteHint(err, id);
      }

      const data: NotesEditData = {
        note_id: id,
        note: result.body,
        applied_changes: appliedChanges,
        source,
        byte_length: byteLength,
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
      render(mode, envelope, (d) => renderNotesEditHuman(d));
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/**
 * Resolve the effective `name` to send on the wire.
 *
 *   - `newName !== undefined` → user passed `--name`; use it directly.
 *   - `newName === undefined` → user passed only content flags; GET the
 *     current note to fetch its name (decision 3).
 *
 * GET errors bubble (rewritten with the show-style hint).
 */
async function resolveEffectiveName(
  client: HttpClient,
  noteId: number,
  newName: string | undefined,
  requestId: string | undefined,
): Promise<string> {
  if (newName !== undefined) return newName;
  let current: Awaited<ReturnType<typeof getNote>>;
  try {
    current = await getNote(client, noteId, {
      ...(requestId !== undefined ? { requestId } : {}),
    });
  } catch (err: unknown) {
    throw rewriteGetNoteHintForEdit(err, noteId);
  }
  const fetched = current.body.name;
  if (fetched === null || fetched === undefined) {
    // Defensive: server returned no name. Surface a typed validation error.
    throw new ValidationError(
      `Could not auto-fetch current name for note ${noteId} (server returned no \`name\` field).`,
      {
        hintNext:
          'Pass --name "<title>" explicitly so the wire body has a value (the API requires `name`).',
      },
    );
  }
  return fetched;
}

async function resolveContent(
  input: '-' | undefined,
  opts: EditOpts,
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
      hintNext: "Pick one of --content, --from-file, --editor, or '-' (stdin).",
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

function rewriteGetNoteHintForEdit(err: unknown, noteId: number): unknown {
  if (!(err instanceof FreeloApiError)) return err;
  const status = err.httpStatus;
  if (status === 403 || status === 404) {
    return new FreeloApiError(err.message, err.code, {
      httpStatus: status,
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext:
        status === 404
          ? `Note ${noteId} not found (auto-fetch GET before edit failed). Run \`freelo notes show ${noteId}\` to verify the id.`
          : `Account does not have permission to read note ${noteId} (auto-fetch GET before edit failed).`,
    });
  }
  return err;
}

function rewriteEditNoteHint(err: unknown, noteId: number): unknown {
  if (!(err instanceof FreeloApiError)) return err;
  const status = err.httpStatus;
  if (status === 400) {
    return new FreeloApiError(err.message, err.code, {
      httpStatus: status,
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: 'Server-side validation rejected the request; verify --name is non-empty.',
    });
  }
  if (status === 403) {
    return new FreeloApiError(err.message, err.code, {
      httpStatus: status,
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: `Account does not have permission to edit note ${noteId}.`,
    });
  }
  if (status === 404) {
    return new FreeloApiError(err.message, err.code, {
      httpStatus: status,
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: `Note ${noteId} not found, or your account does not have permission to edit it.`,
    });
  }
  return err;
}
