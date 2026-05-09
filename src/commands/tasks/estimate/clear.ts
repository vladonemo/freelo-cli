/**
 * `freelo tasks estimate clear <id> [--user <id>] [--yes] [--dry-run]`
 * (R37, spec 0051).
 *
 * Removes a task's time estimate:
 *   - Without `--user`: total team-wide estimate via
 *     `DELETE /task/{id}/total-time-estimate`.
 *   - With `--user <id>`: per-user estimate via
 *     `DELETE /task/{id}/users-time-estimates/{user_id}`. Per-user removal
 *     does not unwind the total (yaml :2361).
 *
 * Destructive — reuses the R13 `confirmDestructive` gate
 * (`src/lib/confirm.ts`) for the single-id flow:
 *   - `--yes` → unconditional proceed.
 *   - `--dry-run` → unconditional proceed (no destructive effect).
 *   - TTY without `--yes` → prompt (scope-specific copy); user declines →
 *     `ConfirmationError` (exit 2).
 *   - Non-TTY without `--yes` → `ConfirmationError` (exit 2) immediately.
 *
 * Idempotency: the server returns 200 even when no estimate existed
 * (yaml :2299, :2362), so the `already_in_target_state` field reflects only
 * the defensive 404 path (forward-compat if Freelo tightens the endpoint).
 * Live 200 always emits `already_in_target_state: false` because the wire
 * cannot distinguish "had an estimate" from "had no estimate" (decision 6).
 *
 * Single-id v1 (no batch). Output schema: `freelo.tasks.estimate.clear/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../../config/schema.js';
import { resolveCredentials } from '../../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../../api/client.js';
import { clearEstimate, totalEstimatePath, userEstimatePath } from '../../../api/tasks-estimate.js';
import {
  type EstimateScope,
  type TasksEstimateClearData,
} from '../../../api/schemas/task-estimate.js';
import { buildEnvelope, type SchemaString } from '../../../ui/envelope.js';
import { dryRunEnvelope } from '../../../lib/dry-run.js';
import { render } from '../../../ui/render.js';
import { renderTasksEstimateClearHuman } from '../../../ui/human/tasks-estimate-clear.js';
import { confirmDestructive } from '../../../lib/confirm.js';
import { handleTopLevelError } from '../../../errors/handle.js';
import { ValidationError } from '../../../errors/validation-error.js';
import { FreeloApiError } from '../../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.estimate.clear/v1',
  destructive: true,
};

const SCHEMA: SchemaString = 'freelo.tasks.estimate.clear/v1';

type ClearOpts = {
  /** Already validated (positive int) by the Commander parser. */
  user?: number;
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

function parseUserIdFlag(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--user must be a positive integer.', {
      hintNext: '--user is the numeric Freelo user id of an assignable worker on the task.',
    });
  }
  return n;
}

/**
 * Walk up to the root program and read the global `--yes` (`-y`) flag.
 * Mirrors the helper in `src/commands/tasks/delete.ts` byte-for-byte —
 * `--yes` is registered on the root program (not the subcommand), so
 * `cmdCtx.opts()` does NOT carry it.
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

/**
 * Build the scope-specific confirmation prompt copy. Spec 0051 decision 7:
 * the scope (and user id, when applicable) is critical context on a
 * destructive op — generic copy would surprise users who passed `--user`.
 */
function buildPromptMessage(taskId: number, userId: number | null): string {
  if (userId === null) {
    return `Clear total time estimate on task #${String(taskId)}?`;
  }
  return `Clear time estimate for user #${String(userId)} on task #${String(taskId)}?`;
}

export function registerEstimateClear(
  estimate: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = estimate
    .command('clear')
    .description(
      "Remove a task's time estimate. Without --user, clears the team-wide total. With --user <id>, clears one user's per-user estimate. Destructive — requires --yes (non-TTY) or interactive confirmation (TTY).",
    )
    .argument('<id>', 'Task id (positive integer).', parseTaskId)
    .option(
      '--user <id>',
      'Numeric user id. When present, clears the per-user estimate instead of the task total. Optional.',
      parseUserIdFlag,
    )
    .option(
      '--dry-run',
      'Skip the DELETE; envelope echoes the path that would have been called. No confirmation prompt fires.',
    );
  attachMeta(cmd, meta);

  cmd.action(async (id: number, opts: ClearOpts, cmdCtx: Command) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;
    const yes = resolveYesFlag(cmdCtx);
    const userId: number | null = opts.user ?? null;
    const scope: EstimateScope = userId === null ? 'total' : 'user';
    const path = userId === null ? totalEstimatePath(id) : userEstimatePath(id, userId);

    try {
      // ---- Dry-run: skip everything (no confirmation, no wire call).
      if (opts.dryRun === true) {
        const data: Record<string, unknown> = {
          task_id: id,
          user_id: userId,
          scope,
          already_in_target_state: false,
        };
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data,
          would: { method: 'DELETE', path, body: {} },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        render(mode, envelope, (d) => renderTasksEstimateClearHuman(d as TasksEstimateClearData));
        return;
      }

      // ---- Confirmation gate (mirrors R13 / R35 single-id flow).
      await confirmDestructive({
        promptMessage: buildPromptMessage(id, userId),
        yes,
        dryRun: false,
      });

      // ---- Live DELETE.
      const client = await buildClient(appConfig, env);
      try {
        const result = await clearEstimate(client, id, userId, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        const data: TasksEstimateClearData = {
          task_id: id,
          user_id: userId,
          scope,
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
        render(mode, envelope, (d) => renderTasksEstimateClearHuman(d));
        return;
      } catch (err: unknown) {
        // Defensive 404 → already-cleared (decision 6 / forward-compat). The
        // server documents 200 for the no-estimate case, but if Freelo ever
        // tightens this we re-classify as idempotent rather than surfacing
        // a confusing NOT_FOUND on a delete-of-nothing.
        if (err instanceof FreeloApiError && err.code === 'NOT_FOUND') {
          const data: TasksEstimateClearData = {
            task_id: id,
            user_id: userId,
            scope,
            already_in_target_state: true,
          };
          const envelope = buildEnvelope({
            schema: SCHEMA,
            data,
            ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
          });
          render(mode, envelope, (d) => renderTasksEstimateClearHuman(d));
          return;
        }
        // Any other error: bubble to the top-level handler.
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
