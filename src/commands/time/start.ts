/**
 * `freelo time start [--task <id>] [--note <str>] [--dry-run]` (R19, spec 0030).
 *
 * Starts a singleton-per-user timer via `POST /timetracking/start`. Both flags
 * are optional — Freelo accepts taskless general-work timers (yaml :2756).
 *
 * Singleton enforcement: a second start while one is already running returns
 * HTTP 409 (yaml :2773-2778). The leaf catches `FreeloApiError` with
 * `httpStatus === 409` and rewrites `hintNext` to point at `time stop` /
 * `time edit` (R20). When possible, the rewriter performs an opportunistic
 * `GET /timetracking/status` follow-up so the hint can name the active task
 * and start time. If the follow-up fails, the hint falls back to generic copy
 * (spec 0030 decision 2).
 *
 * Batch (`--ids` / `--stdin`) is **N/A** — singleton-per-user precludes batch
 * (spec 0030 §2.1 / decision 5). No mutex helpers needed.
 *
 * Output schema: `freelo.time.start/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  buildStartTimerBody,
  getTimerStatus,
  startTimer,
  START_TIMER_PATH,
  type StartTimerResult,
} from '../../api/time.js';
import { type TimeStatusActiveWire } from '../../api/schemas/time.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { render } from '../../ui/render.js';
import { renderTimeStartHuman } from '../../ui/human/time-start.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.time.start/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.time.start/v1';

type StartOpts = {
  task?: number;
  note?: string;
  dryRun?: boolean;
};

/**
 * Parse the `--task` value. Throws `ValidationError` (BaseError, exit 2) —
 * NOT Commander's `InvalidArgumentError` which would map to exit 1
 * (Calibration §1-2).
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

export function registerStart(
  time: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = time
    .command('start')
    .description(
      'Start a time tracking session (singleton per user). Both --task and --note are optional; omit --task for general work. A second start while one is already running returns 409 with a friendly hint.',
    )
    .option(
      '--task <id>',
      'Optional task id to associate with the session. Omit for general (taskless) work.',
      parseTaskFlag,
    )
    .option('--note <str>', 'Optional note attached to the session.')
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (opts: StartOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      const taskId = opts.task; // already validated by parseTaskFlag (or undefined)
      const note = opts.note;
      const body = buildStartTimerBody({
        ...(taskId !== undefined ? { taskId } : {}),
        ...(note !== undefined ? { note } : {}),
      });

      // ---- Dry-run: skip the POST and credential resolution.
      if (opts.dryRun === true) {
        const data = {
          task_id: taskId ?? null,
          note: note ?? null,
        };
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data,
          would: { method: 'POST', path: START_TIMER_PATH, body },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        render(mode, envelope, (d) => renderTimeStartHuman(d));
        return;
      }

      // ---- Live POST.
      const client = await buildClient(appConfig, env);

      let result: StartTimerResult;
      try {
        result = await startTimer(client, {
          body,
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
      } catch (err: unknown) {
        // 409 → opportunistic status fetch to enrich the hint (decision 2).
        throw await rewriteStartHint(err, client, appConfig, taskId);
      }

      const data = {
        uuid: result.response.uuid,
        task_id: taskId ?? null,
        note: note ?? null,
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
      render(mode, envelope, (d) => renderTimeStartHuman(d));
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

/**
 * Hint rewriter for `startTimer` failures. Three branches:
 *
 *   - 409 (singleton conflict): enrich `hintNext` with active-session
 *     details from a follow-up `GET /timetracking/status` (decision 2).
 *     If the follow-up fails or returns 204 (unexpected after a 409),
 *     fall back to the generic hint.
 *   - 404 (task not found): resource-specific hint naming the task id.
 *   - everything else: pass through unchanged.
 *
 * Spec 0030 §2.4.
 */
async function rewriteStartHint(
  err: unknown,
  client: HttpClient,
  appConfig: PartialAppConfig,
  taskId: number | undefined,
): Promise<unknown> {
  if (!(err instanceof FreeloApiError)) return err;

  // 409 — singleton enforcement. Try to enrich the hint.
  if (err.httpStatus === 409) {
    let activeSession: TimeStatusActiveWire | null = null;
    try {
      const statusResult = await getTimerStatus(client, {
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      activeSession = statusResult.status;
    } catch {
      // Opportunistic — failure here just falls back to the generic hint.
      activeSession = null;
    }
    const hintNext = formatSingletonHint(activeSession);
    return new FreeloApiError(err.message, err.code, {
      httpStatus: err.httpStatus,
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext,
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
    });
  }

  // 404 — task not found.
  if (err.httpStatus === 404 && taskId !== undefined) {
    return new FreeloApiError(err.message, err.code, {
      httpStatus: err.httpStatus,
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: `Task ${taskId} not found, or your account does not have access to it.`,
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
    });
  }

  return err;
}

/**
 * Format the singleton-409 hint. With a successful status follow-up, name
 * the active task and start time. Otherwise emit the generic copy.
 *
 * Spec 0030 §2.4 — copy intentionally pinned in this function so the test
 * can assert it byte-for-byte.
 */
function formatSingletonHint(active: TimeStatusActiveWire | null): string {
  if (active === null) {
    return 'A time tracking session is already running for your account. Use `freelo time stop` to finalize it, or `freelo time edit` to reassign the task / note (R20).';
  }
  const taskPart =
    active.task !== null && active.task !== undefined
      ? ` on task #${active.task.id} "${active.task.name ?? '(unnamed)'}"`
      : ' (no task)';
  return `A time tracking session is already running (started ${active.date_reported}${taskPart}). Use \`freelo time stop\` to finalize it as a work report, or \`freelo time edit\` to reassign the task / note (R20).`;
}
