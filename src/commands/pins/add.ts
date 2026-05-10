/**
 * `freelo pins add --project <id> --link <url> [--title <str>] [--dry-run]`
 * (R44, spec 0058).
 *
 * Pins a URL to a project via `POST /project/{project_id}/pinned-items`
 * (yaml :1067-1107).
 *
 * Server-side dispatcher (yaml :1078-1080):
 *   - **Internal-resource URLs** (task, document, file, project-link,
 *     project-directory) are **fetch-or-create idempotent** — the server
 *     returns the existing pin if one already exists.
 *   - **External URLs** always create a new row.
 *
 * The CLI does not distinguish the two cases client-side (decision 10 —
 * would require ad-hoc URL inspection that drifts from Freelo's recognizer).
 *
 * **Wire field is `link` (NOT `url`)** — yaml :1094, decision 12.
 *
 * No client-side URL syntax validation (decision 13).
 *
 * Output schema: `freelo.pins.add/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import { buildPinItemBody, pinItem, pinnedItemsPath, type PinItemResult } from '../../api/pins.js';
import { type PinsAddData } from '../../api/schemas/pin.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { render } from '../../ui/render.js';
import { renderPinsAddHuman } from '../../ui/human/pins-add.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.pins.add/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.pins.add/v1';

type AddOpts = {
  project?: number;
  link?: string;
  title?: string;
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

export function registerAdd(
  pins: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = pins
    .command('add')
    .description(
      'Pin a URL to a project. Internal-resource URLs (tasks, documents, files, project-links) are fetch-or-create idempotent server-side — duplicates return the existing pin. External URLs always create a new pin.',
    )
    .option('--project <id>', 'Target project id (required, positive integer).', parseProjectFlag)
    .option('--link <url>', 'Full URL to pin (required). Wire field is "link", not "url".')
    .option(
      '--title <str>',
      'Optional display title. If omitted, the server derives one from the link.',
    )
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (opts: AddOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      if (opts.project === undefined) {
        throw new ValidationError('--project is required.', {
          hintNext: '--project is the numeric project id from `freelo projects list`.',
        });
      }
      const projectId = opts.project;

      const link = opts.link;
      if (link === undefined || link.trim().length === 0) {
        throw new ValidationError('--link is required and must be a non-empty URL.', {
          hintNext:
            'Pass --link "<url>" — Freelo accepts any URL; internal-resource URLs are fetch-or-create idempotent.',
        });
      }

      // --title (when set): allow empty string only if explicitly provided?
      // We mirror the rest of the codebase: trim-empty is rejected to avoid
      // shipping whitespace-only titles.
      let title: string | undefined;
      if (opts.title !== undefined) {
        if (opts.title.trim().length === 0) {
          throw new ValidationError('--title must be a non-empty string when supplied.', {
            hintNext:
              'Pass --title "<display>" with at least one non-whitespace character, or omit --title to let the server derive a default.',
          });
        }
        title = opts.title;
      }

      const body = buildPinItemBody(title !== undefined ? { link, title } : { link });

      // ---- Dry-run.
      if (opts.dryRun === true) {
        const dryData: PinsAddData = {
          project_id: projectId,
          applied_link: link,
          ...(title !== undefined ? { applied_title: title } : {}),
        };
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data: dryData,
          would: { method: 'POST', path: pinnedItemsPath(projectId), body },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        render(mode, envelope, (d) => renderPinsAddHuman(d));
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

      let result: PinItemResult;
      try {
        result = await pinItem(client, projectId, body, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
      } catch (err: unknown) {
        throw rewriteAddPinHint(err, projectId);
      }

      const data: PinsAddData = {
        project_id: projectId,
        pin: result.body,
        applied_link: link,
        ...(title !== undefined ? { applied_title: title } : {}),
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
      render(mode, envelope, (d) => renderPinsAddHuman(d));
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

function rewriteAddPinHint(err: unknown, projectId: number): unknown {
  if (!(err instanceof FreeloApiError)) return err;
  const status = err.httpStatus;
  if (status === 400) {
    return new FreeloApiError(err.message, err.code, {
      httpStatus: status,
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext:
        'Server-side validation rejected the request; verify --link is a well-formed URL and the project is one you can write to.',
    });
  }
  if (status === 403) {
    return new FreeloApiError(err.message, err.code, {
      httpStatus: status,
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: `Account does not have permission to pin items in project ${projectId}.`,
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
