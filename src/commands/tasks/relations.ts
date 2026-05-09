/**
 * `freelo tasks relations <id>` (R38, spec 0052).
 *
 * Read-only. Returns all typed relations on a single task. Wire:
 * `GET /task/{id}/relations` (yaml :1943-1969). Empty array on no relations
 * is a valid 200. Relations to tasks the caller cannot access are filtered
 * server-side (yaml :1950).
 *
 * Single-id v1. No `--dry-run` — the command is read-only and dry-run on
 * a pure GET is a no-op surprise (spec 0052 decision 5).
 *
 * Output schema: `freelo.tasks.relations/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { getTaskRelations } from '../../api/tasks-relations.js';
import { type TaskRelation, type TasksRelationsData } from '../../api/schemas/task-relations.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderTasksRelationsHuman } from '../../ui/human/tasks-relations.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.relations/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.tasks.relations/v1';

function parseTaskId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('<id> must be a positive integer.', {
      hintNext: '<id> is the numeric task id from `freelo tasks list`.',
    });
  }
  return n;
}

export function registerRelations(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = tasks
    .command('relations')
    .description(
      'Show all typed relations on a single task (blocked_by, blocks, related_to, duplicate_of). Read-only. Empty array if the task has no relations. Relations to tasks the caller cannot access are silently filtered out by Freelo.',
    )
    .argument('<id>', 'Task id (positive integer).', parseTaskId);
  attachMeta(cmd, meta);

  cmd.action(async (id: number) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      const client = await buildClient(appConfig, env);
      const result = await getTaskRelations(client, id, {
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });

      // Cast: the schema validates the wire shape; the envelope `data`
      // type narrows `related_task_name` to `string | null | undefined`
      // (zod's nullable.optional). We surface the validated array as-is.
      const relations: TaskRelation[] = result.body.relations;
      const data: TasksRelationsData = {
        task_id: id,
        relations,
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
      render(mode, envelope, (d) => renderTasksRelationsHuman(d));
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
