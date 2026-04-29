/**
 * `freelo task-labels detach --task <id> (--name <str>|--uuid <id>)... [--hex <color>] [--dry-run]`
 * (R24, spec 0036).
 *
 * Detach one or more labels from a task. Each `--name` and `--uuid` becomes
 * an entry in a single bulk POST.
 *
 * Maps to **`POST /task-labels/remove-from-task/{task_id}`** (verb is POST,
 * not DELETE — spec 0036 decision 01).
 *
 * Per-entry `oneOf` modes (yaml :5171-5204):
 *   - UUID-mode: `{ uuid }` — removes the label by UUID.
 *   - Name-only: `{ name }` — removes ALL labels with that name (any color).
 *     **Aggressive — removes multiple labels if they share the name.**
 *   - Name+color: `{ name, color }` — removes only the matching label.
 *
 * `--hex` upgrades every name-mode entry from name-only → name+color in
 * one call. UUID-mode entries ignore `--hex`.
 *
 * Server is already idempotent (200 even when the label isn't on the task).
 * No 404 heuristic needed.
 *
 * Not destructive at the workspace level (label definitions persist) —
 * no `--yes`, no confirmation prompt.
 *
 * Output schema: `freelo.task_labels.detach/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  buildRemoveTaskLabelsBody,
  removeTaskLabelsFromTask,
  removeTaskLabelsPath,
} from '../../api/task-labels.js';
import { type TaskLabelsDetachData } from '../../api/schemas/task-label.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { render } from '../../ui/render.js';
import { renderTaskLabelsDetachHuman } from '../../ui/human/task-labels-detach.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.task_labels.detach/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.task_labels.detach/v1';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type DetachOpts = {
  task?: number;
  name?: string[];
  uuid?: string[];
  hex?: string;
  dryRun?: boolean;
};

/* ---------------------------------------------------------------------------
 *  Input parsers — typed errors per Calibration §2.
 * ------------------------------------------------------------------------- */

function parseTaskIdFlag(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--task must be a positive integer.', {
      hintNext: '--task is the numeric task id from `freelo tasks list`.',
    });
  }
  return n;
}

function collectName(raw: string, prev: string[] | undefined): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('--name must be a non-empty string.', {
      hintNext: 'Pass a label name, e.g. --name "Bug".',
    });
  }
  return prev ? [...prev, raw] : [raw];
}

function collectUuid(raw: string, prev: string[] | undefined): string[] {
  if (!UUID.test(raw)) {
    throw new ValidationError('--uuid must be a UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).', {
      hintNext: 'Pass the UUID of a label to remove.',
    });
  }
  return prev ? [...prev, raw] : [raw];
}

function parseHexColorFlag(raw: string): string {
  if (!HEX_COLOR.test(raw)) {
    throw new ValidationError('--hex must match the pattern #RRGGBB (six hex digits).', {
      hintNext: 'Pass a six-digit hex color, e.g. --hex "#9b59b6".',
    });
  }
  return raw;
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerDetach(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = parent
    .command('detach')
    .description(
      'Detach one or more labels from a task. --name without --hex removes ALL labels with that name (aggressive); add --hex to scope to a specific (name,color) pair. UUID-mode is precise — removes exactly that label. Server is idempotent — detaching a label not on the task is a successful no-op.',
    )
    .requiredOption('--task <id>', 'Numeric task id (target).', parseTaskIdFlag)
    .option(
      '--name <str>',
      'Label name (repeatable). Name-only mode unless --hex is set (then name+color mode).',
      collectName,
    )
    .option(
      '--uuid <id>',
      'Label UUID (repeatable). UUID-mode entry — precise removal by UUID.',
      collectUuid,
    )
    .option(
      '--hex <color>',
      'Color in #RRGGBB format. When provided, all --name entries upgrade from name-only to name+color mode (precise). Ignored for --uuid entries.',
      parseHexColorFlag,
    )
    .option('--dry-run', 'Skip the POST; envelope echoes the wire body in `would`.');
  attachMeta(cmd, meta);

  cmd.action(async (opts: DetachOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      const names = opts.name ?? [];
      const uuids = opts.uuid ?? [];
      if (names.length === 0 && uuids.length === 0) {
        throw new ValidationError('At least one --name or --uuid is required.', {
          hintNext: 'Pass --name "Bug" or --uuid <id> (both repeatable).',
        });
      }

      const taskId = opts.task!;
      const body = buildRemoveTaskLabelsBody({
        uuids,
        names,
        ...(opts.hex !== undefined ? { color: opts.hex } : {}),
      });

      if (opts.dryRun === true) {
        emitDryRun(taskId, body, appConfig);
        return;
      }

      await runLive(taskId, body, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Flow helpers
 * ------------------------------------------------------------------------- */

function entriesForEnvelope(
  body: ReturnType<typeof buildRemoveTaskLabelsBody>,
): TaskLabelsDetachData['labels'] {
  return body.labels.map((entry) => {
    const out: { uuid?: string; name?: string; color?: string } = {};
    if ('uuid' in entry && entry.uuid !== undefined) out.uuid = entry.uuid;
    if ('name' in entry && entry.name !== undefined) out.name = entry.name;
    if ('color' in entry && entry.color !== undefined) out.color = entry.color;
    return out;
  });
}

function emitDryRun(
  taskId: number,
  body: ReturnType<typeof buildRemoveTaskLabelsBody>,
  appConfig: PartialAppConfig,
): void {
  const mode = appConfig.output.mode;
  const dryData: TaskLabelsDetachData = {
    task_id: taskId,
    labels: entriesForEnvelope(body),
    count: body.labels.length,
  };
  const envelope = dryRunEnvelope({
    schema: SCHEMA,
    data: dryData,
    would: { method: 'POST', path: removeTaskLabelsPath(taskId), body },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  render(mode, envelope, (d) => renderTaskLabelsDetachHuman(d));
}

async function runLive(
  taskId: number,
  body: ReturnType<typeof buildRemoveTaskLabelsBody>,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const client = await buildClient(appConfig, env);

  const result = await removeTaskLabelsFromTask(client, taskId, {
    body,
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });

  const data: TaskLabelsDetachData = {
    task_id: taskId,
    labels: entriesForEnvelope(body),
    count: body.labels.length,
  };
  const envelope: Envelope<TaskLabelsDetachData> = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: result.raw.rateLimit.remaining,
      reset_at: result.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  render(mode, envelope, (d) => renderTaskLabelsDetachHuman(d));
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
