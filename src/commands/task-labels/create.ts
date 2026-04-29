/**
 * `freelo task-labels create --name <str>... [--hex <color>] [--dry-run]`
 * (R24, spec 0036).
 *
 * Bulk-create task-label definitions in the caller's account. Server-side
 * fetch-or-create on `name` (case-sensitive) — the API does not report
 * which were new vs. reused, so the CLI cannot distinguish either.
 *
 * Maps to **`POST /task-labels`**. One POST per command (the API is
 * bulk-by-design; no per-name fan-out — spec 0036 decision 05).
 *
 * Color flag is named `--hex` (not `--color`) to avoid colliding with the
 * global `--color <mode>` flag (spec 0036 decision 02; mirrors R23
 * `labels attach` decision 11).
 *
 * Output schema: `freelo.task_labels.create/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  TASK_LABELS_PATH,
  buildCreateTaskLabelsBody,
  createTaskLabels,
} from '../../api/task-labels.js';
import { type TaskLabelsCreateData } from '../../api/schemas/task-label.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { render } from '../../ui/render.js';
import { renderTaskLabelsCreateHuman } from '../../ui/human/task-labels-create.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.task_labels.create/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.task_labels.create/v1';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

type CreateOpts = {
  name?: string[];
  hex?: string;
  dryRun?: boolean;
};

/* ---------------------------------------------------------------------------
 *  Input parsers — typed errors per Calibration §2.
 * ------------------------------------------------------------------------- */

function collectName(raw: string, prev: string[] | undefined): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('--name must be a non-empty string.', {
      hintNext: 'Pass a label name, e.g. --name "Bug".',
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

export function registerCreate(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = parent
    .command('create')
    .description(
      'Bulk-create task-label definitions in the caller account. Server-side fetch-or-create on `name` (case-sensitive) — re-running with the same names is a safe no-op. The API does not report new vs. reused.',
    )
    .option(
      '--name <str>',
      'Label name (repeatable). Each --name becomes one entry in the bulk POST.',
      collectName,
    )
    .option(
      '--hex <color>',
      'Color in #RRGGBB format. Applied to every --name in this call (spec 0036 decision 04). Named `--hex` (not `--color`) to avoid the root global `--color <mode>` flag — see decision 02.',
      parseHexColorFlag,
    )
    .option('--dry-run', 'Skip the POST; envelope echoes the wire body in `would`.');
  attachMeta(cmd, meta);

  cmd.action(async (opts: CreateOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      const names = opts.name;
      if (names === undefined || names.length === 0) {
        throw new ValidationError('At least one --name is required.', {
          hintNext: 'Pass --name "Bug" (repeatable for multiple labels).',
        });
      }

      const body = buildCreateTaskLabelsBody({
        names,
        ...(opts.hex !== undefined ? { color: opts.hex } : {}),
      });

      if (opts.dryRun === true) {
        emitDryRun(body, appConfig);
        return;
      }

      await runLive(body, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Flow helpers
 * ------------------------------------------------------------------------- */

function envelopeData(body: ReturnType<typeof buildCreateTaskLabelsBody>): TaskLabelsCreateData {
  return {
    labels: body.labels.map((entry) => ({
      name: entry.name,
      ...(entry.color !== undefined ? { color: entry.color } : {}),
    })),
    count: body.labels.length,
  };
}

function emitDryRun(
  body: ReturnType<typeof buildCreateTaskLabelsBody>,
  appConfig: PartialAppConfig,
): void {
  const mode = appConfig.output.mode;
  const envelope = dryRunEnvelope({
    schema: SCHEMA,
    data: envelopeData(body),
    would: { method: 'POST', path: TASK_LABELS_PATH, body },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  render(mode, envelope, (d) => renderTaskLabelsCreateHuman(d));
}

async function runLive(
  body: ReturnType<typeof buildCreateTaskLabelsBody>,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const client = await buildClient(appConfig, env);

  const result = await createTaskLabels(client, {
    body,
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });

  const data = envelopeData(body);
  const envelope: Envelope<TaskLabelsCreateData> = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: result.raw.rateLimit.remaining,
      reset_at: result.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  render(mode, envelope, (d) => renderTaskLabelsCreateHuman(d));
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
