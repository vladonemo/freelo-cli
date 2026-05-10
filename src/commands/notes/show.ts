/**
 * `freelo notes show <id>` (R44, spec 0058).
 *
 * Single-resource read via `GET /note/{note_id}` (yaml :4602-4624). Returns
 * the full Note shape (id, name, content, dates, state, author, project,
 * files[], comments[]).
 *
 * No `--with` side-cars in v1 — the Note already embeds files + comments.
 *
 * Output schema: `freelo.notes.show/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import { getNote } from '../../api/notes.js';
import { type NotesShowData } from '../../api/schemas/note.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderNotesShowHuman } from '../../ui/human/notes-show.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.notes.show/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.notes.show/v1';

/**
 * Parse the `<id>` positional. Throws `ValidationError` (BaseError, exitCode
 * 2) — NOT Commander's `InvalidArgumentError` which would map to exit 1
 * (Calibration §1-2).
 */
function parseNoteId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('<id> must be a positive integer.', {
      hintNext: '<id> is the numeric note id (returned from `freelo notes create`).',
    });
  }
  return n;
}

export function registerShow(
  notes: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = notes
    .command('show')
    .description('Show a single note by id, including its full content, files, and comments.')
    .argument('<id>', 'Numeric note id.', parseNoteId);
  attachMeta(cmd, meta);

  cmd.action(async (id: number) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
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

      let result: Awaited<ReturnType<typeof getNote>>;
      try {
        result = await getNote(client, id, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
      } catch (err: unknown) {
        throw rewriteGetNoteHint(err, id);
      }

      const data: NotesShowData = { note: result.body };
      const envelope = buildEnvelope({
        schema: SCHEMA,
        data,
        rateLimit: {
          remaining: result.raw.rateLimit.remaining,
          reset_at: result.raw.rateLimit.resetAt,
        },
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      render(mode, envelope, (d) => renderNotesShowHuman(d));
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

function rewriteGetNoteHint(err: unknown, noteId: number): unknown {
  if (!(err instanceof FreeloApiError)) return err;
  const status = err.httpStatus;
  if (status === 403) {
    return new FreeloApiError(err.message, err.code, {
      httpStatus: status,
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: `Account does not have permission to read note ${noteId}.`,
    });
  }
  if (status === 404) {
    return new FreeloApiError(err.message, err.code, {
      httpStatus: status,
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: `Note ${noteId} not found, or your account does not have permission to read it (Freelo collapses the two cases to avoid leaking note existence).`,
    });
  }
  return err;
}
