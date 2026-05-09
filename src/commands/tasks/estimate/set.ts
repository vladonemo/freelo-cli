/**
 * `freelo tasks estimate set <id> --minutes <n> [--user <id>] [--dry-run]`
 * (R37, spec 0051).
 *
 * Sets (or upserts) a task's time estimate, in minutes:
 *   - Without `--user`: total team-wide estimate via
 *     `POST /task/{id}/total-time-estimate`.
 *   - With `--user <id>`: per-user estimate via
 *     `POST /task/{id}/users-time-estimates/{user_id}`. Per-user estimates
 *     are independent of the total (yaml :2325).
 *
 * Non-destructive — server upserts (yaml :2267, :2324). No confirmation
 * gate; `--dry-run` echoes the body that would have been sent.
 *
 * Single-id v1 (no batch). See spec 0051 decision 8.
 *
 * Output schema: `freelo.tasks.estimate.set/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../../config/schema.js';
import { resolveCredentials } from '../../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../../api/client.js';
import { setEstimate, totalEstimatePath, userEstimatePath } from '../../../api/tasks-estimate.js';
import {
  type EstimateScope,
  type TasksEstimateSetData,
} from '../../../api/schemas/task-estimate.js';
import { buildEnvelope, type SchemaString } from '../../../ui/envelope.js';
import { dryRunEnvelope } from '../../../lib/dry-run.js';
import { render } from '../../../ui/render.js';
import { renderTasksEstimateSetHuman } from '../../../ui/human/tasks-estimate-set.js';
import { handleTopLevelError } from '../../../errors/handle.js';
import { ValidationError } from '../../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.estimate.set/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.tasks.estimate.set/v1';

type SetOpts = {
  /** Already validated (positive int) by the Commander parser. */
  minutes?: number;
  /** Already validated (positive int) by the Commander parser. */
  user?: number;
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

/**
 * Parse `--user <id>`. Same positive-integer rule as the task-id parser.
 * Surfaces a typed `ValidationError` (exit 2) so missing/garbage routes
 * through `handleTopLevelError`, not Commander's exit-1 path.
 */
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
 * Parse `--minutes <n>`. Positive integer (>= 1). The OpenAPI documents
 * `type: integer` without an explicit lower bound, but a zero-or-negative
 * estimate is semantically nonsense and collides with `clear`. See spec
 * 0051 decision 4.
 */
function parseMinutesFlag(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--minutes must be a positive integer.', {
      hintNext: 'Pass a whole number of minutes >= 1, e.g. --minutes 90 for 1.5 hours.',
    });
  }
  return n;
}

export function registerEstimateSet(
  estimate: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = estimate
    .command('set')
    .description(
      "Set or update a task's time estimate (in minutes). Without --user, sets the team-wide total estimate. With --user <id>, sets a per-user estimate (independent of the total). Server upserts on every call.",
    )
    .argument('<id>', 'Task id (positive integer).', parseTaskId)
    .option('--minutes <n>', 'Estimate in minutes (positive integer). Required.', parseMinutesFlag)
    .option(
      '--user <id>',
      'Numeric user id of an assignable worker. When present, sets the per-user estimate instead of the task total. Optional.',
      parseUserIdFlag,
    )
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (id: number, opts: SetOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // `--minutes` is required. Commander does not enforce required-ness on
      // `.option()`; we surface the missing-flag error as a typed
      // ValidationError so the exit code is 2 (calibration §1-2) and the
      // envelope routes through `handleTopLevelError`.
      if (opts.minutes === undefined) {
        throw new ValidationError('--minutes is required for `tasks estimate set`.', {
          hintNext: 'Pass --minutes <positive integer>, e.g. --minutes 120 for a 2-hour estimate.',
        });
      }
      const minutes = opts.minutes;
      const userId: number | null = opts.user ?? null;
      const scope: EstimateScope = userId === null ? 'total' : 'user';
      const path = userId === null ? totalEstimatePath(id) : userEstimatePath(id, userId);

      // ---- Dry-run: skip the POST and credential resolution.
      if (opts.dryRun === true) {
        const data: Record<string, unknown> = {
          task_id: id,
          user_id: userId,
          minutes,
          scope,
        };
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data,
          would: { method: 'POST', path, body: { minutes } },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        render(mode, envelope, (d) => renderTasksEstimateSetHuman(d as TasksEstimateSetData));
        return;
      }

      // ---- Live POST.
      const client = await buildClient(appConfig, env);
      const result = await setEstimate(client, id, minutes, userId, {
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });

      const data: TasksEstimateSetData = {
        task_id: id,
        user_id: userId,
        minutes,
        scope,
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
      render(mode, envelope, (d) => renderTasksEstimateSetHuman(d));
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
