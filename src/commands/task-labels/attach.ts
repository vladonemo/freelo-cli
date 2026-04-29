/**
 * `freelo task-labels attach --task <id> (--name <str>|--uuid <id>)... [--hex <color>] [--dry-run]`
 * (R24, spec 0036).
 *
 * Attach one or more labels to a task. Each `--name` and `--uuid` becomes
 * an entry in a single bulk POST (spec 0036 decision 05 — no fan-out).
 *
 * Maps to **`POST /task-labels/add-to-task/{task_id}`**.
 *
 * Per-entry `oneOf` modes (yaml :5139-5169):
 *   - UUID-mode: `{ uuid }` — references an existing label by UUID.
 *   - Name-mode: `{ name, color?, uuid? }` — fetch-or-create on (name, color).
 *     Server defaults to `#77787a` (gray) when `color` is omitted.
 *
 * `--hex` applies to name-mode entries only (UUID-mode entries don't carry
 * color — server uses the existing label's color).
 *
 * Output schema: `freelo.task_labels.attach/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  addTaskLabelsPath,
  addTaskLabelsToTask,
  buildAddTaskLabelsBody,
} from '../../api/task-labels.js';
import { type TaskLabelsAttachData } from '../../api/schemas/task-label.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { render } from '../../ui/render.js';
import { renderTaskLabelsAttachHuman } from '../../ui/human/task-labels-attach.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.task_labels.attach/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.task_labels.attach/v1';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type AttachOpts = {
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
      hintNext: 'Pass the UUID of an existing task label.',
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

export function registerAttach(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = parent
    .command('attach')
    .description(
      "Attach one or more labels to a task. Each --name and --uuid becomes one entry in a single bulk POST. --hex applies to name-mode entries only (UUID-mode uses the existing label's color).",
    )
    .requiredOption('--task <id>', 'Numeric task id (target).', parseTaskIdFlag)
    .option(
      '--name <str>',
      'Label name (repeatable). Name-mode entry — fetch-or-create by (name, color).',
      collectName,
    )
    .option(
      '--uuid <id>',
      'Existing label UUID (repeatable). UUID-mode entry — assigns the label as-is.',
      collectUuid,
    )
    .option(
      '--hex <color>',
      'Color in #RRGGBB format. Applied to all --name entries; ignored for --uuid entries. Server defaults to #77787a (gray) when omitted.',
      parseHexColorFlag,
    )
    .option('--dry-run', 'Skip the POST; envelope echoes the wire body in `would`.');
  attachMeta(cmd, meta);

  cmd.action(async (opts: AttachOpts) => {
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
      const body = buildAddTaskLabelsBody({
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
  body: ReturnType<typeof buildAddTaskLabelsBody>,
): TaskLabelsAttachData['labels'] {
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
  body: ReturnType<typeof buildAddTaskLabelsBody>,
  appConfig: PartialAppConfig,
): void {
  const mode = appConfig.output.mode;
  const dryData: TaskLabelsAttachData = {
    task_id: taskId,
    labels: entriesForEnvelope(body),
    count: body.labels.length,
  };
  const envelope = dryRunEnvelope({
    schema: SCHEMA,
    data: dryData,
    would: { method: 'POST', path: addTaskLabelsPath(taskId), body },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  render(mode, envelope, (d) => renderTaskLabelsAttachHuman(d));
}

async function runLive(
  taskId: number,
  body: ReturnType<typeof buildAddTaskLabelsBody>,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const client = await buildClient(appConfig, env);

  const result = await addTaskLabelsToTask(client, taskId, {
    body,
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });

  const data: TaskLabelsAttachData = {
    task_id: taskId,
    labels: entriesForEnvelope(body),
    count: body.labels.length,
  };
  const envelope: Envelope<TaskLabelsAttachData> = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: result.raw.rateLimit.remaining,
      reset_at: result.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  render(mode, envelope, (d) => renderTaskLabelsAttachHuman(d));
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
