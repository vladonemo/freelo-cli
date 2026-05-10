/**
 * `freelo pins list --project <id>` (R44, spec 0058).
 *
 * Read-only. Lists all pinned items on a project via
 * `GET /project/{project_id}/pinned-items` (yaml :1040-1067). The
 * response is a flat array (no pagination — yaml :1054).
 *
 * ACL-filtered server-side (yaml :1053): pins whose target the caller
 * cannot see are silently omitted.
 *
 * No `--dry-run` (read-only — same R40 / R43 precedent).
 *
 * Output schema: `freelo.pins.list/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import { getPinnedItems } from '../../api/pins.js';
import { type PinsListData } from '../../api/schemas/pin.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { renderAsync } from '../../ui/render.js';
import { renderPinsListHuman } from '../../ui/human/pins-list.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.pins.list/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.pins.list/v1';

type ListOpts = {
  project?: number;
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

export function registerList(
  pins: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = pins
    .command('list')
    .description(
      'List all pinned items on a project (links, tasks, documents, files, project-links, directories). ACL-filtered server-side. Flat array — no pagination.',
    )
    .option('--project <id>', 'Project id (required, positive integer).', parseProjectFlag);
  attachMeta(cmd, meta);

  cmd.action(async (opts: ListOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      if (opts.project === undefined) {
        throw new ValidationError('--project is required.', {
          hintNext:
            'Pass --project <id> where <id> is the numeric project id from `freelo projects list`.',
        });
      }
      const projectId = opts.project;

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

      let result: Awaited<ReturnType<typeof getPinnedItems>>;
      try {
        result = await getPinnedItems(client, projectId, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
      } catch (err: unknown) {
        throw rewriteListPinsHint(err, projectId);
      }

      const data: PinsListData = {
        project_id: projectId,
        pins: result.body,
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
      await renderAsync(mode, envelope, (d) => renderPinsListHuman(d));
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

function rewriteListPinsHint(err: unknown, projectId: number): unknown {
  if (!(err instanceof FreeloApiError)) return err;
  const status = err.httpStatus;
  if (status === 403) {
    return new FreeloApiError(err.message, err.code, {
      httpStatus: status,
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: `Account does not have permission to read pinned items on project ${projectId}.`,
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
