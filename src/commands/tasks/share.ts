/**
 * `freelo tasks share <id> [--dry-run]` (R36, spec 0050).
 *
 * Get-or-create the public, unauthenticated URL that lets anyone holding
 * the link view the task read-only. Non-destructive — Freelo's
 * `GET /public-link/task/{id}` is idempotent on the wire (first call
 * creates, subsequent calls return the same URL; yaml :2150). The CLI
 * cannot distinguish first-vs-Nth call, so the envelope's `created`
 * field stays `null` (spec 0050 decision 2).
 *
 * Verb note: the roadmap shorthand says POST; the authoritative OpenAPI
 * documents this as GET. We follow the yaml. Spec 0050 decision 1.
 *
 * Single-id v1 (no batch). Output schema: `freelo.tasks.share/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { publicLinkPath, shareTask } from '../../api/tasks-share.js';
import { DRY_RUN_URL_PLACEHOLDER, type TasksShareData } from '../../api/schemas/task-share.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { render } from '../../ui/render.js';
import { renderTasksShareHuman } from '../../ui/human/tasks-share.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.share/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.tasks.share/v1';

type ShareOpts = {
  dryRun?: boolean;
};

/**
 * Parse the `<id>` positional. Throws `ValidationError` (BaseError, exit 2)
 * — NOT Commander's `InvalidArgumentError` which would map to exit 1
 * (calibration §1-2).
 */
function parseTaskId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('<id> must be a positive integer.', {
      hintNext: '<id> is the numeric task id from `freelo tasks list`.',
    });
  }
  return n;
}

export function registerShare(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = tasks
    .command('share')
    .description(
      'Get (or create) a public, unauthenticated URL for a task. Anyone holding the URL can view the task read-only. Idempotent on the wire — first call creates the link, subsequent calls return the same URL.',
    )
    .argument('<id>', 'Task id (positive integer).', parseTaskId)
    .option('--dry-run', 'Skip the GET; envelope echoes the path that would have been called.');
  attachMeta(cmd, meta);

  cmd.action(async (id: number, opts: ShareOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // ---- Dry-run: skip the GET and credential resolution.
      if (opts.dryRun === true) {
        const data: Record<string, unknown> = {
          task_id: id,
          url: DRY_RUN_URL_PLACEHOLDER,
          created: null,
        };
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data,
          would: { method: 'GET', path: publicLinkPath(id), body: {} },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        render(mode, envelope, (d) => renderTasksShareHuman(d as TasksShareData));
        return;
      }

      // ---- Live GET (idempotent on the server side).
      const client = await buildClient(appConfig, env);
      const result = await shareTask(client, id, {
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });

      const data: TasksShareData = {
        task_id: id,
        url: result.body.url,
        created: null,
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
      render(mode, envelope, (d) => renderTasksShareHuman(d));
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
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
