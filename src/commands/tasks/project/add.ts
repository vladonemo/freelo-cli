/**
 * `freelo tasks project add <id> --tasklist <id>... [--dry-run]`
 * (R38, spec 0052).
 *
 * Promotes a task into one or more secondary projects (UVVP).
 *
 *   - Wire: `POST /task/{id}/projects` with body `{ tasklist_id: <int> }`
 *     (yaml :1893-1941). The target project is derived from the tasklist.
 *   - `--tasklist` is repeatable: each value fans out to one POST (decision 3).
 *   - Duplicate tasklist values are deduplicated (decision 4).
 *   - Mid-fan-out failure: bubble the failing call as `FreeloApiError`,
 *     truncating `assignments` to the entries completed so far.
 *   - Dry-run: one collapsed envelope; no wire calls; `would.body.tasklist_ids`
 *     enumerates the targets (decision 6).
 *
 * Non-destructive — server upserts on duplicates; no confirmation gate.
 * Output schema: `freelo.tasks.project.add/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../../config/schema.js';
import { resolveCredentials } from '../../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../../api/client.js';
import { assignTaskPath, assignTaskToProject } from '../../../api/tasks-projects.js';
import {
  type ProjectAddAssignment,
  type TasksProjectAddData,
} from '../../../api/schemas/task-projects.js';
import { buildEnvelope, type SchemaString } from '../../../ui/envelope.js';
import { dryRunEnvelope } from '../../../lib/dry-run.js';
import { render } from '../../../ui/render.js';
import { renderTasksProjectAddHuman } from '../../../ui/human/tasks-project-add.js';
import { handleTopLevelError } from '../../../errors/handle.js';
import { ValidationError } from '../../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.project.add/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.tasks.project.add/v1';

type AddOpts = {
  tasklist?: number[];
  dryRun?: boolean;
};

function parseTaskId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('<id> must be a positive integer.', {
      hintNext: '<id> is the numeric task id from `freelo tasks list`.',
    });
  }
  return n;
}

/**
 * Repeatable `--tasklist <id>` collector. Each value must be a positive
 * integer; on bad input throws `ValidationError` (exit 2) — Commander would
 * route `InvalidArgumentError` to exit 1, which violates the calibration §1-2
 * exit-code contract.
 */
function collectTasklistId(raw: string, prev: number[] | undefined): number[] {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--tasklist must be a positive integer.', {
      hintNext:
        '--tasklist is the numeric tasklist id from `freelo tasklists list --project <id>`.',
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

export function registerProjectAdd(
  project: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = project
    .command('add')
    .description(
      'Add a task to one or more secondary projects (multi-project membership). Each --tasklist <id> flag adds the task to the project that owns that tasklist; the server creates a child task there. Repeatable; one POST per --tasklist (deduplicated).',
    )
    .argument('<id>', 'Task id (positive integer).', parseTaskId)
    .option(
      '--tasklist <id>',
      'Numeric tasklist id (repeatable). The target project is derived from the tasklist by Freelo. At least one required.',
      collectTasklistId,
    )
    .option(
      '--dry-run',
      'Skip the POST(s); envelope echoes the body that would have been sent. One collapsed envelope.',
    );
  attachMeta(cmd, meta);

  cmd.action(async (id: number, opts: AddOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // ---- Validation: at least one --tasklist required.
      if (opts.tasklist === undefined || opts.tasklist.length === 0) {
        throw new ValidationError('--tasklist is required (at least one).', {
          hintNext:
            'Pass --tasklist <id> for each target tasklist, e.g. --tasklist 100 --tasklist 200.',
        });
      }
      const tasklistIds = dedupe(opts.tasklist);
      const path = assignTaskPath(id);

      // ---- Dry-run: one collapsed envelope, no wire calls.
      if (opts.dryRun === true) {
        const data: Record<string, unknown> = {
          task_id: id,
          tasklist_ids: tasklistIds,
        };
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data,
          would: { method: 'POST', path, body: { tasklist_ids: tasklistIds } },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        render(mode, envelope, (d) => renderTasksProjectAddHuman(d as TasksProjectAddData));
        return;
      }

      // ---- Live fan-out.
      const client = await buildClient(appConfig, env);
      const assignments: ProjectAddAssignment[] = [];
      let lastRateLimit: { remaining: number | null; resetAt: string | null } | undefined;

      // Sequential — preserves call ordering for the assignments echo and
      // makes mid-fan-out failure deterministic. N is small (typical 1–3).
      for (const tlid of tasklistIds) {
        const result = await assignTaskToProject(client, id, tlid, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        assignments.push({
          tasklist_id: tlid,
          child_task_id: result.body.task.id,
          child_task_uuid: result.body.task.uuid,
        });
        lastRateLimit = result.raw.rateLimit;
      }

      const data: TasksProjectAddData = {
        task_id: id,
        tasklist_ids: tasklistIds,
        assignments,
      };
      const envelope = buildEnvelope({
        schema: SCHEMA,
        data,
        ...(lastRateLimit !== undefined
          ? {
              rateLimit: {
                remaining: lastRateLimit.remaining,
                reset_at: lastRateLimit.resetAt,
              },
            }
          : {}),
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      render(mode, envelope, (d) => renderTasksProjectAddHuman(d));
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
