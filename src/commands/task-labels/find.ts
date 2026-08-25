/**
 * `freelo task-labels find [--project <id>]` (M04, spec 0062).
 *
 * Lists every task label usable by the caller — the name→uuid resolver that
 * `task-labels attach --uuid` needs and that R24 had no endpoint for.
 *
 * Maps to **`GET /task-labels/find-available`** (yaml :2841-2876). Results are
 * sorted by `name` ascending server-side; the CLI does not re-sort.
 *
 * Read-only: no `--dry-run` (nothing to preview), no confirmation gate.
 *
 * **Empty is a success.** The server answers HTTP 200 `{ "labels": [] }` both
 * when `--project` names a project the caller can't reach and when the caller
 * has no accessible projects at all — and it does not distinguish the two.
 * The command renders an empty list and exits 0. Spec 0062 §5 / decision 04.
 *
 * Distinct from `freelo labels list` (`GET /project-labels/find-available`,
 * R23) — separate endpoint, id-keyed items, no query parameters. Spec 0062
 * §3.1.
 *
 * Output schema: `freelo.task_labels.find/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import { findAvailableTaskLabels } from '../../api/task-labels.js';
import { type TaskLabelsFindData } from '../../api/schemas/task-label.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { renderAsync } from '../../ui/render.js';
import { renderTaskLabelsFindHuman } from '../../ui/human/task-labels-find.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.task_labels.find/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.task_labels.find/v1';

type FindOpts = {
  project?: number;
};

/**
 * `--project` parser. Throws `ValidationError` (exit 2), not Commander's
 * `InvalidArgumentError` (which falls through to exit 1) — calibration §2.
 */
function parseProjectIdFlag(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--project must be a positive integer.', {
      hintNext: '--project is the numeric project id from `freelo projects list`.',
    });
  }
  return n;
}

export function registerFind(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = parent
    .command('find')
    .description(
      'List the task labels usable by the caller (uuid, name, color), sorted by name. Use it to resolve a label name to the uuid that `task-labels attach --uuid` takes. An empty result is a success, not an error — the API returns no labels both for an inaccessible --project and for an account with no accessible projects, and does not distinguish the two.',
    )
    .option(
      '--project <id>',
      'Numeric project id. Restricts results to labels used in that one project. Omitted → every label usable by the caller.',
      parseProjectIdFlag,
    );
  attachMeta(cmd, meta);

  cmd.action(async (opts: FindOpts) => {
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

      const result = await findAvailableTaskLabels(client, {
        ...(opts.project !== undefined ? { projectId: opts.project } : {}),
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });

      const data: TaskLabelsFindData = {
        labels: result.labels,
        count: result.labels.length,
        ...(opts.project !== undefined ? { project_id: opts.project } : {}),
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
      await renderAsync(mode, envelope, (d) => renderTaskLabelsFindHuman(d));
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}
