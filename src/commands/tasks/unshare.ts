/**
 * `freelo tasks unshare <id> [--yes] [--dry-run]` (R36, spec 0050).
 *
 * Revoke the task's public share URL. **Destructive** — invalidates any
 * previously shared link immediately. Reuses the R13 / R35 confirmation
 * gate (`src/lib/confirm.ts`):
 *   - `--yes` → unconditional proceed.
 *   - `--dry-run` → unconditional proceed (no destructive effect).
 *   - TTY without `--yes` → prompt; user declines → `ConfirmationError` (exit 2).
 *   - Non-TTY without `--yes` → `ConfirmationError` (exit 2) immediately.
 *
 * Idempotency (spec 0050 decision 5): a 200 response emits
 * `already_in_target_state: false`; a defensive 404 (forward-compat path,
 * for if Freelo ever tightens the endpoint) is re-classified as
 * `already_in_target_state: true`.
 *
 * Single-id v1. Output schema: `freelo.tasks.unshare/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { publicLinkPath, unshareTask } from '../../api/tasks-share.js';
import { type TasksUnshareData } from '../../api/schemas/task-share.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { render } from '../../ui/render.js';
import { renderTasksUnshareHuman } from '../../ui/human/tasks-unshare.js';
import { confirmDestructive } from '../../lib/confirm.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.unshare/v1',
  destructive: true,
};

const SCHEMA: SchemaString = 'freelo.tasks.unshare/v1';

type UnshareOpts = {
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
 * Mirrors the helper in `src/commands/tasks/delete.ts` and
 * `src/commands/tasks/remind/clear.ts` byte-for-byte — `--yes` is
 * registered on the root program (not the subcommand), so
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

export function registerUnshare(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = tasks
    .command('unshare')
    .description(
      "Revoke the task's public share URL. Destructive — invalidates any previously shared URL immediately. Requires --yes (non-TTY) or interactive confirmation (TTY).",
    )
    .argument('<id>', 'Task id (positive integer).', parseTaskId)
    .option(
      '--dry-run',
      'Skip the DELETE; envelope echoes the path that would have been called. No confirmation prompt fires.',
    );
  attachMeta(cmd, meta);

  cmd.action(async (id: number, opts: UnshareOpts, cmdCtx: Command) => {
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
          would: { method: 'DELETE', path: publicLinkPath(id), body: {} },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        render(mode, envelope, (d) => renderTasksUnshareHuman(d as TasksUnshareData));
        return;
      }

      // ---- Confirmation gate (mirrors R13 single-id flow).
      await confirmDestructive({
        promptMessage: `Revoke public share link on task #${String(id)}?`,
        yes,
        dryRun: false,
      });

      // ---- Live DELETE.
      const client = await buildClient(appConfig, env);
      try {
        const result = await unshareTask(client, id, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        const data: TasksUnshareData = {
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
        render(mode, envelope, (d) => renderTasksUnshareHuman(d));
        return;
      } catch (err: unknown) {
        // Defensive 404 → already-revoked (decision 5 / forward-compat).
        // The OpenAPI is silent on the no-link case; if Freelo ever
        // tightens this endpoint we re-classify the 404 as idempotent
        // rather than surfacing a confusing NOT_FOUND on a delete-of-nothing.
        if (err instanceof FreeloApiError && err.code === 'NOT_FOUND') {
          const data: TasksUnshareData = {
            task_id: id,
            already_in_target_state: true,
          };
          const envelope = buildEnvelope({
            schema: SCHEMA,
            data,
            ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
          });
          render(mode, envelope, (d) => renderTasksUnshareHuman(d));
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
