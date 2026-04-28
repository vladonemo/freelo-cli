/**
 * `freelo time status` (R19, spec 0030).
 *
 * Reads the caller's currently-running time tracking session via
 * `GET /timetracking/status`. Two equally-normal outcomes:
 *
 *   - 200 OK with a session body → envelope `{ active: true, session: {...} }`.
 *   - 204 No Content → envelope `{ active: false }`. **Not** an error.
 *
 * The shared HTTP client extension (`src/api/client.ts` 204 branch, spec
 * 0030 §2.5) feeds `null` to the schema on 204; this leaf converts that
 * into the inactive arm of the discriminated union.
 *
 * Output schema: `freelo.time.status/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import { getTimerStatus } from '../../api/time.js';
import {
  type TimeStatusActiveWire,
  type TimeStatusData,
  type TimeStatusSession,
} from '../../api/schemas/time.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderTimeStatusHuman } from '../../ui/human/time-status.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.time.status/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.time.status/v1';

export function registerStatus(
  time: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = time
    .command('status')
    .description(
      "Print the caller's currently-running time tracking session, or { active: false } when no timer is running. Returns exit 0 in both cases.",
    );
  attachMeta(cmd, meta);

  cmd.action(async () => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      const creds = await resolveCredentials({
        profile: appConfig.profile,
        apiBaseUrl: appConfig.apiBaseUrl,
        env,
      });
      const client = createHttpClient({
        email: creds.email,
        apiKey: creds.apiKey,
        apiBaseUrl: creds.apiBaseUrl,
        userAgent: appConfig.userAgent,
      });

      const result = await getTimerStatus(client, {
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });

      const data: TimeStatusData =
        result.status === null
          ? { active: false }
          : { active: true, session: projectSession(result.status, Date.now()) };

      const envelope = buildEnvelope({
        schema: SCHEMA,
        data,
        rateLimit: {
          remaining: result.raw.rateLimit.remaining,
          reset_at: result.raw.rateLimit.resetAt,
        },
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      render(mode, envelope, (d) => renderTimeStatusHuman(d));
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/**
 * Project the wire shape (`TimeStatusActiveWire`) onto the public-contract
 * shape (`TimeStatusSession`).
 *
 * Renames `date_reported` → `started_at` (decision 4) and computes
 * `elapsed_seconds` (clamped at 0 for clock skew or malformed timestamps).
 *
 * Defaults applied for fields the wire shape declares optional but the
 * envelope shape requires:
 *   - `note` → `null` when missing.
 *   - `is_billable`, `is_cost_fixed` → `false`.
 *   - `labels` → `[]`.
 *   - `cost` → `null` (unknown wire shape; we don't promise it).
 *   - `project_setting` → `null`.
 *
 * Exported for unit testing — pure, no I/O.
 */
export function projectSession(wire: TimeStatusActiveWire, nowMs: number): TimeStatusSession {
  const startedMs = Date.parse(wire.date_reported);
  const elapsed = Number.isNaN(startedMs) ? 0 : Math.max(0, Math.floor((nowMs - startedMs) / 1000));

  const taskWire = wire.task ?? null;
  const task: TimeStatusSession['task'] =
    taskWire === null
      ? null
      : {
          id: taskWire.id,
          name: taskWire.name ?? null,
          project:
            taskWire.project !== null && taskWire.project !== undefined
              ? { id: taskWire.project.id, name: taskWire.project.name ?? null }
              : null,
          tasklist:
            taskWire.tasklist !== null && taskWire.tasklist !== undefined
              ? { id: taskWire.tasklist.id, name: taskWire.tasklist.name ?? null }
              : null,
        };

  return {
    uuid: wire.uuid,
    started_at: wire.date_reported,
    elapsed_seconds: elapsed,
    task,
    note: wire.note ?? null,
    is_billable: wire.is_billable ?? false,
    is_cost_fixed: wire.is_cost_fixed ?? false,
    labels: (wire.labels ?? []).map((l) => ({ name: l.name })),
    cost: wire.cost ?? null,
    project_setting: wire.project_setting ?? null,
  };
}
