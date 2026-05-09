/**
 * `freelo tasks find-relations --task <id>...` (R38, spec 0052).
 *
 * Read-only bulk relations query. Wire: `POST /tasks/relations` with body
 * `{ task_ids: [<int>, ...] }` (yaml :1614-1660). 1–100 ids per call;
 * server-side `maxItems: 100` (yaml :1636) is enforced client-side as a
 * `ValidationError` (decision 7).
 *
 * Note: Despite the verb being POST, this endpoint is **read-only** —
 * it does NOT create relations. The OpenAPI documents no relation-create
 * endpoint at all. The CLI command name `find-relations` reflects this.
 *
 * Tasks the caller cannot access are silently omitted from the response
 * (yaml :1622). Agents diff `data.task_ids` against `data.tasks[*].task_id`
 * to detect inaccessible ids.
 *
 * Single bulk POST (no fan-out). No positional argument; flag-driven
 * (mirrors `projects invite`). No `--dry-run` (decision 5 — pure read).
 *
 * Output schema: `freelo.tasks.find-relations/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { findTaskRelations } from '../../api/tasks-relations.js';
import { type TasksFindRelationsData } from '../../api/schemas/task-relations.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderTasksFindRelationsHuman } from '../../ui/human/tasks-find-relations.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.find-relations/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.tasks.find-relations/v1';

const MAX_TASK_IDS = 100;

type FindOpts = {
  task?: number[];
};

/**
 * Repeatable `--task <id>` collector. Each value must be a positive integer;
 * on bad input throws `ValidationError` (exit 2) — Commander would route
 * `InvalidArgumentError` to exit 1 (calibration §1-2).
 */
function collectTaskId(raw: string, prev: number[] | undefined): number[] {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--task must be a positive integer.', {
      hintNext:
        '--task is the numeric task id from `freelo tasks list`. Repeatable; max 100 per call.',
    });
  }
  return prev ? [...prev, n] : [n];
}

/** Deduplicate while preserving first-occurrence order. */
function dedupe(ids: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function registerFindRelations(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = tasks
    .command('find-relations')
    .description(
      'Bulk-fetch typed relations for many tasks at once (1–100 per call). Read-only — does NOT create relations. Tasks the caller cannot access are silently omitted from the response; diff `data.task_ids` against `data.tasks[*].task_id` to detect inaccessible ids.',
    )
    .option(
      '--task <id>',
      'Numeric task id (repeatable). At least one, at most 100. Required.',
      collectTaskId,
    );
  attachMeta(cmd, meta);

  cmd.action(async (opts: FindOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // ---- Validation: at least one --task required.
      if (opts.task === undefined || opts.task.length === 0) {
        throw new ValidationError('--task is required (at least one).', {
          hintNext:
            'Pass --task <id> for each task to query, e.g. --task 4567 --task 4568. Up to 100 per call.',
        });
      }
      const taskIds = dedupe(opts.task);
      if (taskIds.length > MAX_TASK_IDS) {
        throw new ValidationError(
          `--task accepts at most ${String(MAX_TASK_IDS)} ids per call (got ${String(taskIds.length)}).`,
          {
            hintNext: 'Split your query across multiple invocations.',
          },
        );
      }

      // ---- Live POST.
      const client = await buildClient(appConfig, env);
      const result = await findTaskRelations(client, taskIds, {
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });

      const data: TasksFindRelationsData = {
        task_ids: taskIds,
        tasks: result.body.tasks.map((t) => ({
          task_id: t.task_id,
          relations: t.relations,
        })),
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
      render(mode, envelope, (d) => renderTasksFindRelationsHuman(d));
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
