/**
 * `freelo time stop [--dry-run]` (R20, spec 0032).
 *
 * Finalizes the caller's active time tracking session as a work report via
 * `POST /timetracking/stop`. Per the OpenAPI spec (yaml :2780-2809), the
 * endpoint takes **no request body** — it always targets the caller's own
 * active session (singleton-per-user). Returns a `WorkReport`.
 *
 * No `--note` flag (despite the roadmap proposal). The OpenAPI spec doesn't
 * document a `note` body field, and sending one would be guessing API
 * behavior — a hard rule violation. Users who want to stamp a final note
 * should chain `freelo time edit --note "..." && freelo time stop`. See
 * spec 0032 decision 1.
 *
 * No-active-session enforcement: HTTP 409 with `"Timetracking is not running."`
 * The leaf catches `FreeloApiError` with `httpStatus === 409` and rewrites
 * `hintNext` to point at `time start` (spec 0032 §2.4 / decision 7 — no
 * status follow-up; the hint already says "no session").
 *
 * Batch (`--ids` / `--stdin`) is **N/A** — singleton-per-user precludes batch
 * (same as R19 `time start`).
 *
 * Output schema: `freelo.time.stop/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { stopTimer, STOP_TIMER_PATH, type StopTimerResult } from '../../api/time.js';
import {
  type TimeStopLiveData,
  type TimeStopResponse,
  type TimeStopWorkReport,
} from '../../api/schemas/time.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { render } from '../../ui/render.js';
import { renderTimeStopHuman } from '../../ui/human/time-stop.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.time.stop/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.time.stop/v1';

type StopOpts = {
  dryRun?: boolean;
};

export function registerStop(
  time: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = time
    .command('stop')
    .description(
      'Stop the active time tracking session and emit the resulting work report. Returns 409 with a friendly hint when no session is running.',
    )
    .option(
      '--dry-run',
      'Skip the POST; envelope echoes the path that would have been called (no body).',
    );
  attachMeta(cmd, meta);

  cmd.action(async (opts: StopOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // ---- Dry-run: skip the POST and credential resolution.
      if (opts.dryRun === true) {
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data: {},
          // No body on stop — `null` is the explicit "no body" marker.
          would: { method: 'POST', path: STOP_TIMER_PATH, body: null },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        render(mode, envelope, (d) => renderTimeStopHuman(d));
        return;
      }

      // ---- Live POST.
      const client = await buildClient(appConfig, env);

      let result: StopTimerResult;
      try {
        result = await stopTimer(client, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
      } catch (err: unknown) {
        // 409 → no-active-session hint rewriter (spec 0032 §2.4).
        throw rewriteNoActiveHint(err);
      }

      const data: TimeStopLiveData = {
        work_report: projectWorkReport(result.workReport),
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
      render(mode, envelope, (d) => renderTimeStopHuman(d));
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
 * Rewrite `FreeloApiError` `hintNext` for the 409 no-active-session case.
 * Other errors pass through unchanged. Shared by `time edit`'s leaf via
 * the same shape. Exported for test inspection if needed.
 *
 * Spec 0032 §2.4 / decision 7 (no status follow-up — there's nothing useful
 * to enrich the "you have no session" hint with).
 */
export function rewriteNoActiveHint(err: unknown): unknown {
  if (!(err instanceof FreeloApiError) || err.httpStatus !== 409) return err;
  return new FreeloApiError(err.message, err.code, {
    httpStatus: err.httpStatus,
    errors: err.errors,
    rawBody: err.rawBody,
    hintNext:
      'No active time tracking session for your account. Use `freelo time start` to begin one.',
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
  });
}

/**
 * Project the wire `WorkReport` (`TimeStopResponse`) onto the public-contract
 * shape (`TimeStopWorkReport`).
 *
 * Tightens inner refs (cost, worker, author, task) — drops the `.passthrough()`
 * carry from the wire. Any wire field that's `null|undefined` becomes `null`
 * on the envelope so agents see a stable shape regardless of which optional
 * fields Freelo actually populated.
 *
 * Pure — no I/O.
 *
 * Spec 0032 decision 5.
 */
export function projectWorkReport(wire: TimeStopResponse): TimeStopWorkReport {
  const task: TimeStopWorkReport['task'] =
    wire.task !== null && wire.task !== undefined
      ? { id: wire.task.id, name: wire.task.name ?? null }
      : null;
  const cost: TimeStopWorkReport['cost'] =
    wire.cost !== null && wire.cost !== undefined
      ? { amount: wire.cost.amount, currency: wire.cost.currency }
      : null;
  const worker: TimeStopWorkReport['worker'] =
    wire.worker !== null && wire.worker !== undefined
      ? { id: wire.worker.id, fullname: wire.worker.fullname ?? null }
      : null;
  const author: TimeStopWorkReport['author'] =
    wire.author !== null && wire.author !== undefined
      ? { id: wire.author.id, fullname: wire.author.fullname ?? null }
      : null;
  return {
    id: wire.id,
    date_add: wire.date_add,
    date_reported: wire.date_reported,
    minutes: wire.minutes,
    note: wire.note ?? null,
    task,
    cost,
    worker,
    author,
  };
}
