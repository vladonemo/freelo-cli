/**
 * `freelo tasks project remove <id> --project <id> [--yes] [--dry-run]`
 * (R38, spec 0052).
 *
 * Removes a task from a single secondary project (rolls back a prior
 * `tasks project add`). Wire: `DELETE /task/{id}/projects/{project_id}`
 * (yaml :1971-2000).
 *
 * Single-id v1 — `--project` is NOT repeatable on `remove` (decision: the
 * destructive prompt copy and exit-code semantics get muddled when one DELETE
 * succeeds and another 403s). For batch removal, loop in user code.
 *
 * Destructive — reuses the R13 `confirmDestructive` gate
 * (`src/lib/confirm.ts`):
 *   - `--yes` → unconditional proceed.
 *   - `--dry-run` → unconditional proceed (no destructive effect).
 *   - TTY without `--yes` → prompt; user declines → `ConfirmationError` (exit 2).
 *   - Non-TTY without `--yes` → `ConfirmationError` (exit 2) immediately.
 *
 * Idempotency (decision 8):
 *   - Live 200 → `already_in_target_state: false`.
 *   - 404      → `already_in_target_state: true` (yaml :1985 — first-class
 *                 documented signal "task not present in given project").
 *   - 403      → bubbles as `FreeloApiError` with a `hintNext` pointing at
 *                 `tasks delete` (the server returns 403 AclException when
 *                 the caller tries to remove the **primary** project — yaml
 *                 :1984).
 *
 * Output schema: `freelo.tasks.project.remove/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../../config/schema.js';
import { resolveCredentials } from '../../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../../api/client.js';
import { removeTaskFromProject, removeTaskFromProjectPath } from '../../../api/tasks-projects.js';
import { type TasksProjectRemoveData } from '../../../api/schemas/task-projects.js';
import { buildEnvelope, type SchemaString } from '../../../ui/envelope.js';
import { dryRunEnvelope } from '../../../lib/dry-run.js';
import { render } from '../../../ui/render.js';
import { renderTasksProjectRemoveHuman } from '../../../ui/human/tasks-project-remove.js';
import { confirmDestructive } from '../../../lib/confirm.js';
import { handleTopLevelError } from '../../../errors/handle.js';
import { ValidationError } from '../../../errors/validation-error.js';
import { FreeloApiError } from '../../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.project.remove/v1',
  destructive: true,
};

const SCHEMA: SchemaString = 'freelo.tasks.project.remove/v1';

type RemoveOpts = {
  project?: number;
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

function parseProjectIdFlag(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--project must be a positive integer.', {
      hintNext:
        '--project is the numeric id of the SECONDARY project to remove the task from. Removing the primary project requires `freelo tasks delete <id>`.',
    });
  }
  return n;
}

/**
 * Walk up to the root program and read the global `--yes` (`-y`) flag.
 * `--yes` is registered on the root program (not the subcommand), so
 * `cmdCtx.opts()` does NOT carry it. Mirrors `tasks/delete.ts` /
 * `tasks/estimate/clear.ts`.
 */
function resolveYesFlag(cmd: Command): boolean {
  let cur: Command | null = cmd;
  while (cur && cur.parent) {
    cur = cur.parent;
  }
  if (cur === null) return false;
  const opts = cur.opts<{ yes?: boolean }>();
  return opts.yes === true;
}

export function registerProjectRemove(
  project: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = project
    .command('remove')
    .description(
      'Remove a task from a single SECONDARY project. Removing the task entirely (incl. its primary project) requires `freelo tasks delete <id>` instead — Freelo returns 403 AclException on primary-project removal attempts. Destructive; requires --yes (non-TTY) or interactive confirmation (TTY).',
    )
    .argument('<id>', 'Task id (positive integer).', parseTaskId)
    .option(
      '--project <id>',
      'Numeric id of the SECONDARY project to remove the task from. Required.',
      parseProjectIdFlag,
    )
    .option(
      '--dry-run',
      'Skip the DELETE; envelope echoes the path that would have been called. No confirmation prompt fires.',
    );
  attachMeta(cmd, meta);

  cmd.action(async (id: number, opts: RemoveOpts, cmdCtx: Command) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;
    const yes = resolveYesFlag(cmdCtx);

    try {
      // ---- Validation: --project is required.
      if (opts.project === undefined) {
        throw new ValidationError('--project is required.', {
          hintNext:
            'Pass --project <id> for the secondary project to remove the task from. To remove the task entirely, use `freelo tasks delete <id>`.',
        });
      }
      const projectId = opts.project;
      const path = removeTaskFromProjectPath(id, projectId);

      // ---- Dry-run: skip everything (no confirmation, no wire call).
      if (opts.dryRun === true) {
        const data: Record<string, unknown> = {
          task_id: id,
          project_id: projectId,
          already_in_target_state: false,
        };
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data,
          would: { method: 'DELETE', path, body: {} },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        render(mode, envelope, (d) => renderTasksProjectRemoveHuman(d as TasksProjectRemoveData));
        return;
      }

      // ---- Confirmation gate (mirrors R13 / R35 / R36 / R37 single-id flow).
      await confirmDestructive({
        promptMessage: `Remove task #${String(id)} from project #${String(projectId)}?`,
        yes,
        dryRun: false,
      });

      // ---- Live DELETE.
      const client = await buildClient(appConfig, env);
      try {
        const result = await removeTaskFromProject(client, id, projectId, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        const data: TasksProjectRemoveData = {
          task_id: id,
          project_id: projectId,
          already_in_target_state: false,
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
        render(mode, envelope, (d) => renderTasksProjectRemoveHuman(d));
        return;
      } catch (err: unknown) {
        // 404 → first-class idempotency (yaml :1985 documents this signal).
        if (err instanceof FreeloApiError && err.code === 'NOT_FOUND') {
          const data: TasksProjectRemoveData = {
            task_id: id,
            project_id: projectId,
            already_in_target_state: true,
          };
          const envelope = buildEnvelope({
            schema: SCHEMA,
            data,
            ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
          });
          render(mode, envelope, (d) => renderTasksProjectRemoveHuman(d));
          return;
        }
        // 403 → annotate with a hint pointing at `tasks delete` (yaml :1984).
        // The server returns 403 AclException when the caller tries to remove
        // the task's PRIMARY project; the hint redirects to the right verb.
        if (err instanceof FreeloApiError && err.code === 'FORBIDDEN') {
          const opts: ConstructorParameters<typeof FreeloApiError>[2] = {
            ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
            ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
            errors: err.errors,
            rawBody: err.rawBody,
            hintNext:
              'Removing a task entirely (incl. its primary project) requires `freelo tasks delete <id>`. This endpoint only removes a task from a SECONDARY project.',
          };
          throw new FreeloApiError(err.message, 'FORBIDDEN', opts);
        }
        throw err;
      }
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
