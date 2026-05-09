/**
 * `freelo tasks remind set <id> --at <ISO> [--dry-run]` (R35, spec 0049).
 *
 * Schedules (or overwrites) the calling user's personal reminder on a task.
 * Non-destructive — upsert semantics on the server (yaml :2081). No
 * confirmation gate; `--dry-run` echoes the body that would have been sent.
 *
 * `--at <ISO>` is required and validated by `parseIsoTimestampFutureFlag` —
 * RFC 3339 / ISO 8601 input, canonicalized to second-precision UTC, rejects
 * past values >60 s ago (clock-skew clamp from spec 0049 decision 2).
 *
 * Single-id v1 (no batch). See spec 0049 decision 6.
 *
 * Output schema: `freelo.tasks.remind.set/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../../config/schema.js';
import { resolveCredentials } from '../../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../../api/client.js';
import { reminderPath, setReminder } from '../../../api/tasks-reminder.js';
import { type TasksRemindSetData } from '../../../api/schemas/task-reminder.js';
import { buildEnvelope, type SchemaString } from '../../../ui/envelope.js';
import { dryRunEnvelope } from '../../../lib/dry-run.js';
import { render } from '../../../ui/render.js';
import { renderTasksRemindSetHuman } from '../../../ui/human/tasks-remind-set.js';
import { handleTopLevelError } from '../../../errors/handle.js';
import { ValidationError } from '../../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../../lib/introspect.js';
import { parseIsoTimestampFutureFlag } from '../../../lib/iso-timestamp-future.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.remind.set/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.tasks.remind.set/v1';

type SetOpts = {
  /** Already canonicalized to UTC by `parseIsoTimestampFutureFlag` at parse time. */
  at?: string;
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

export function registerRemindSet(
  remind: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = remind
    .command('set')
    .description(
      'Schedule (or overwrite) your personal reminder for a task. --at is required; reminders are per-user — they only ping the caller, not other workers on the task.',
    )
    .argument('<id>', 'Task id (positive integer).', parseTaskId)
    .option(
      '--at <iso>',
      'UTC ISO 8601 timestamp when the reminder should fire (required). Accepts timezone offsets and bare YYYY-MM-DD; normalized to UTC before sending.',
      (raw) => parseIsoTimestampFutureFlag('--at', raw),
    )
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (id: number, opts: SetOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // `--at` is required. Commander does not enforce required-ness on
      // `.option()`; we surface the missing-flag error as our own typed
      // ValidationError so the exit code is 2 (calibration §1-2) and the
      // envelope routes through `handleTopLevelError`.
      if (opts.at === undefined) {
        throw new ValidationError('--at is required for `tasks remind set`.', {
          hintNext: 'Pass --at <UTC ISO 8601 timestamp>, e.g. --at 2099-01-01T09:00:00Z.',
        });
      }
      const remindAt = opts.at;

      // ---- Dry-run: skip the POST and credential resolution.
      if (opts.dryRun === true) {
        const data: Record<string, unknown> = {
          task_id: id,
          remind_at: remindAt,
        };
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data,
          would: { method: 'POST', path: reminderPath(id), body: { remind_at: remindAt } },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        render(mode, envelope, (d) => renderTasksRemindSetHuman(d as TasksRemindSetData));
        return;
      }

      // ---- Live POST.
      const client = await buildClient(appConfig, env);
      const result = await setReminder(client, id, remindAt, {
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });

      const data: TasksRemindSetData = {
        task_id: id,
        task_name: result.body.task.name ?? null,
        remind_at: result.body.remind_at,
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
      render(mode, envelope, (d) => renderTasksRemindSetHuman(d));
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
