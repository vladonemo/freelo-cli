/**
 * `freelo labels list` (R23, spec 0035 §3.2).
 *
 * Lists the caller's available project labels via
 * `GET /project-labels/find-available`.
 *
 * No filters in v1 — the documented endpoint accepts no query parameters
 * and the response items carry no `attached_projects` field, so the
 * roadmap's `[--project <id>]` flag is deferred (spec 0035 decision 03).
 *
 * Output schema: `freelo.labels.list/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import { findAvailableLabels } from '../../api/project-labels.js';
import { type LabelsListData } from '../../api/schemas/project-label.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { renderAsync } from '../../ui/render.js';
import { renderLabelsListHuman } from '../../ui/human/labels-list.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.labels.list/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.labels.list/v1';

export function registerList(
  labels: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = labels
    .command('list')
    .description(
      "List the caller's available project labels (their private labels plus public labels from accessible projects). No filters in v1 — `--project` is deferred until the API surfaces an attachments map.",
    );
  attachMeta(cmd, meta);

  cmd.action(async () => {
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

      const result = await findAvailableLabels(client, {
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });

      const data: LabelsListData = { labels: result.labels };
      const envelope = buildEnvelope({
        schema: SCHEMA,
        data,
        rateLimit: {
          remaining: result.raw.rateLimit.remaining,
          reset_at: result.raw.rateLimit.resetAt,
        },
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      await renderAsync(mode, envelope, (d) => renderLabelsListHuman(d));
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}
