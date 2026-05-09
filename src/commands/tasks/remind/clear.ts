/**
 * `freelo tasks remind clear <id> [--yes] [--dry-run]` (R35, spec 0049).
 *
 * Removes the calling user's personal reminder on a task. Destructive —
 * reuses the R13 `confirmDestructive` gate (`src/lib/confirm.ts`) for the
 * single-id flow:
 *   - `--yes` → unconditional proceed.
 *   - `--dry-run` → unconditional proceed (no destructive effect).
 *   - TTY without `--yes` → prompt; user declines → `ConfirmationError` (exit 2).
 *   - Non-TTY without `--yes` → `ConfirmationError` (exit 2) immediately.
 *
 * Idempotency: the server returns 200 even when no reminder existed
 * (yaml :2125), so the `already_in_target_state` field reflects only the
 * defensive 404 path (forward-compat if Freelo tightens the endpoint).
 * Live 200 always emits `already_in_target_state: false` because the wire
 * cannot distinguish "had a reminder" from "had no reminder" (decision 4).
 *
 * Single-id v1 (no batch). Output schema: `freelo.tasks.remind.clear/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../../config/schema.js';
import { resolveCredentials } from '../../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../../api/client.js';
import { clearReminder, reminderPath } from '../../../api/tasks-reminder.js';
import { type TasksRemindClearData } from '../../../api/schemas/task-reminder.js';
import { buildEnvelope, type SchemaString } from '../../../ui/envelope.js';
import { dryRunEnvelope } from '../../../lib/dry-run.js';
import { render } from '../../../ui/render.js';
import { renderTasksRemindClearHuman } from '../../../ui/human/tasks-remind-clear.js';
import { confirmDestructive } from '../../../lib/confirm.js';
import { handleTopLevelError } from '../../../errors/handle.js';
import { ValidationError } from '../../../errors/validation-error.js';
import { FreeloApiError } from '../../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.remind.clear/v1',
  destructive: true,
};

const SCHEMA: SchemaString = 'freelo.tasks.remind.clear/v1';

type ClearOpts = {
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

export function registerRemindClear(
  remind: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = remind
    .command('clear')
    .description(
      'Remove your personal reminder for a task. Destructive — requires --yes (non-TTY) or interactive confirmation (TTY).',
    )
    .argument('<id>', 'Task id (positive integer).', parseTaskId)
    .option(
      '--dry-run',
      'Skip the DELETE; envelope echoes the path that would have been called. No confirmation prompt fires.',
    );
  attachMeta(cmd, meta);

  cmd.action(async (id: number, opts: ClearOpts, cmdCtx: Command) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;
    const yes = resolveYesFlag(cmdCtx);

    try {
      // ---- Dry-run: skip everything (no confirmation, no wire call).
      if (opts.dryRun === true) {
        const data: Record<string, unknown> = {
          task_id: id,
          already_in_target_state: false,
        };
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data,
          would: { method: 'DELETE', path: reminderPath(id), body: {} },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        render(mode, envelope, (d) => renderTasksRemindClearHuman(d as TasksRemindClearData));
        return;
      }

      // ---- Confirmation gate (mirrors R13 single-id flow).
      await confirmDestructive({
        promptMessage: `Clear reminder on task #${String(id)}?`,
        yes,
        dryRun: false,
      });

      // ---- Live DELETE.
      const client = await buildClient(appConfig, env);
      try {
        const result = await clearReminder(client, id, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        const data: TasksRemindClearData = {
          task_id: id,
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
        render(mode, envelope, (d) => renderTasksRemindClearHuman(d));
        return;
      } catch (err: unknown) {
        // Defensive 404 → already-cleared (decision 4 / forward-compat). The
        // server documents 200 for the no-reminder case, but if Freelo ever
        // tightens this we re-classify as idempotent rather than surfacing
        // a confusing NOT_FOUND on a delete-of-nothing.
        if (err instanceof FreeloApiError && err.code === 'NOT_FOUND') {
          const data: TasksRemindClearData = {
            task_id: id,
            already_in_target_state: true,
          };
          const envelope = buildEnvelope({
            schema: SCHEMA,
            data,
            ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
          });
          render(mode, envelope, (d) => renderTasksRemindClearHuman(d));
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
