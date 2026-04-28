/**
 * `freelo time edit [--task <id>] [--clear-task] [--note <str>] [--dry-run]`
 * (R20, spec 0032).
 *
 * Modifies the running session's `task_id` and/or `note` in flight via
 * `POST /timetracking/edit` (yaml :2811-2861). At least one of `--task`,
 * `--clear-task`, `--note` is required — empty edit is a usage error
 * (`ValidationError` exit 2; spec 0032 §2.5 / decision 4).
 *
 * `--task` / `--clear-task` are mutually exclusive (spec 0032 decision 3):
 *   - `--task <id>`     → wire body `{ task_id: <id> }` (assign / reassign).
 *   - `--clear-task`    → wire body `{ task_id: null }` (disassociate from task).
 *   - both supplied     → `ValidationError` exit 2.
 *
 * `--clear-task` is the disassociate flag — we use a positive name (rather
 * than Commander's negatable `--no-task` form) so the two flags have
 * independent option storage. Otherwise Commander would clobber `--task`'s
 * captured value when `--no-task` was also passed, breaking the mutex check.
 *
 * The HTTP verb is **POST**, not PATCH — the OpenAPI spec contradicts the
 * roadmap's `PATCH` text. Per orchestrator hard rules, the OpenAPI spec is
 * authoritative (decision 8).
 *
 * No `--started-at <ISO>` flag — the OpenAPI body documents only `task_id`
 * and `note`, no backdate field. Deferred to R20.5 (decision 2; mirrors
 * R19 → R19.5 pattern for `--at` on `time start`).
 *
 * No-active-session 409 hint: shared with `time stop` via `rewriteNoActiveHint`
 * imported from `./stop.js`.
 *
 * Output schema: `freelo.time.edit/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  buildEditTimerBody,
  editTimer,
  EDIT_TIMER_PATH,
  type EditTimerResult,
} from '../../api/time.js';
import { type TimeEditAppliedChanges, type TimeEditLiveData } from '../../api/schemas/time.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { render } from '../../ui/render.js';
import { renderTimeEditHuman } from '../../ui/human/time-edit.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';
import { rewriteNoActiveHint } from './stop.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.time.edit/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.time.edit/v1';

/**
 * Commander's negatable `--no-<flag>` form would clobber `--task`'s storage
 * (Commander uses a single property for the positive/negative pair). To keep
 * the two flags independent — so we can detect the mutex case `--task 4567
 * --clear-task` regardless of argv order — we declare a plain boolean
 * `--clear-task` flag with its own option storage. Spec 0032 decision 3.
 */
type EditOpts = {
  task?: number;
  clearTask?: boolean;
  note?: string;
  dryRun?: boolean;
};

/**
 * Parse the `--task` value. Throws `ValidationError` (BaseError, exit 2).
 * Mirrors `parseTaskFlag` from `time/start.ts` — same constraints.
 */
function parseTaskFlag(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--task must be a positive integer.', {
      hintNext: '--task is the numeric task id from `freelo tasks list`.',
    });
  }
  return n;
}

export function registerEdit(
  time: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = time
    .command('edit')
    .description(
      'Edit the active time tracking session in flight (--task / --clear-task / --note). At least one flag is required. Returns 409 with a friendly hint when no session is running.',
    )
    .option(
      '--task <id>',
      'Reassign the active session to this numeric task id. Mutually exclusive with --clear-task.',
      parseTaskFlag,
    )
    .option(
      '--clear-task',
      'Disassociate the active session from any task (sends task_id: null on the wire). Mutually exclusive with --task.',
    )
    .option('--note <str>', 'Update the active session note. Empty string is allowed.')
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (opts: EditOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // ---- Validate flag combinations (spec 0032 decisions 3 + 4).
      if (opts.task !== undefined && opts.clearTask === true) {
        throw new ValidationError('--task and --clear-task are mutually exclusive.', {
          hintNext: 'Pass --task <id> to reassign, or --clear-task to disassociate. Not both.',
        });
      }

      // Resolve the effective taskId input:
      //   - opts.task: number → assign
      //   - opts.clearTask: true → null (disassociate)
      //   - neither → undefined (key omitted from body)
      const taskId: number | null | undefined =
        opts.task !== undefined ? opts.task : opts.clearTask === true ? null : undefined;
      const note = opts.note;

      // Empty edit rejected at the command layer (decision 4).
      if (taskId === undefined && note === undefined) {
        throw new ValidationError(
          '`time edit` requires at least one of --task, --clear-task, or --note.',
          {
            hintNext:
              'Pass at least one flag: --task <id> to reassign, --clear-task to disassociate, or --note <str> to update the note.',
          },
        );
      }

      const body = buildEditTimerBody({
        ...(taskId !== undefined ? { taskId } : {}),
        ...(note !== undefined ? { note } : {}),
      });

      // Build `applied_changes` — mirrors the wire body shape exactly
      // (decision 6). Keys present iff the user actually passed the flag.
      const appliedChanges: TimeEditAppliedChanges = {};
      if (taskId !== undefined) appliedChanges.task_id = taskId;
      if (note !== undefined) appliedChanges.note = note;

      // ---- Dry-run: skip POST and credential resolution.
      if (opts.dryRun === true) {
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data: { applied_changes: appliedChanges },
          would: { method: 'POST', path: EDIT_TIMER_PATH, body },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        render(mode, envelope, (d) => renderTimeEditHuman(d));
        return;
      }

      // ---- Live POST.
      const client = await buildClient(appConfig, env);

      let result: EditTimerResult;
      try {
        result = await editTimer(client, {
          body,
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
      } catch (err: unknown) {
        // 409 → shared no-active-session rewriter (spec 0032 §2.4).
        throw rewriteNoActiveHint(err);
      }

      const data: TimeEditLiveData = {
        uuid: result.response.uuid,
        applied_changes: appliedChanges,
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
      render(mode, envelope, (d) => renderTimeEditHuman(d));
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
