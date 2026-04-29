/**
 * `freelo labels attach --project <id> --name <str>... [--hex <color>] [--private | --public] [--dry-run]`
 * (R23, spec 0035; decision 11 — `--hex` instead of spec's `--color` to avoid
 * collision with the root global `--color <mode>` flag).
 *
 * Attach one or more labels to a project. The wire endpoint is **fetch-or-create**:
 * passing a `name` that doesn't yet exist for the caller creates a new label;
 * passing a name that already exists re-uses it (yaml :943). Each `--name`
 * fans out to one POST.
 *
 * Maps to **`POST /project-labels/add-to-project/{projectId}`** (data-mode body).
 * CLI does not surface id-mode (spec 0035 decision 07).
 *
 * `--private` / `--public` selector controls `is_private` on the wire body
 * (default `is_private: true` per decision 06).
 *
 * No `already_in_target_state` field on the envelope (decision 08 — server
 * swallows `UniqueConstraintViolationException` so the CLI cannot
 * distinguish first-attach from re-attach).
 *
 * No `--stdin` in v1 — rich rows would need shape `{ name, is_private?, color? }`.
 *
 * Output schema: `freelo.labels.attach/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  attachLabelPath,
  attachLabelToProject,
  buildAttachProjectLabelBody,
  type AttachProjectLabelInput,
} from '../../api/project-labels.js';
import { type LabelsAttachData } from '../../api/schemas/project-label.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { render } from '../../ui/render.js';
import { renderLabelsAttachHuman } from '../../ui/human/labels-attach.js';
import { ExitCodeAccumulator } from '../../lib/batch.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.labels.attach/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.labels.attach/v1';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

type AttachOpts = {
  project?: number;
  name?: string[];
  hex?: string;
  private?: boolean;
  public?: boolean;
  dryRun?: boolean;
};

/* ---------------------------------------------------------------------------
 *  Input parsers — typed errors per Calibration §2.
 * ------------------------------------------------------------------------- */

function parseProjectIdFlag(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--project must be a positive integer.', {
      hintNext: '--project is the numeric project id from `freelo projects list`.',
    });
  }
  return n;
}

function collectName(raw: string, prev: string[] | undefined): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('--name must be a non-empty string.', {
      hintNext: 'Pass a label name, e.g. --name "Billable".',
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
  labels: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = labels
    .command('attach')
    .description(
      'Attach one or more labels to a project (fetch-or-create per name). One POST per --name. Defaults to private labels (caller-only); use --public for shared labels.',
    )
    .requiredOption('--project <id>', 'Numeric project id (target).', parseProjectIdFlag)
    .option(
      '--name <str>',
      'Label name (repeatable). Each name fans out to one POST. Fetch-or-create on the server.',
      collectName,
    )
    .option(
      '--hex <color>',
      'Color in #RRGGBB format. Applied only when the server creates a new label. Named `--hex` (not `--color`) to avoid collision with the global `--color <mode>` output-colorization flag — see decision 11.',
      parseHexColorFlag,
    )
    .option('--private', 'Attach as a private label (default; mutex with --public).')
    .option('--public', 'Attach as a public label (mutex with --private).')
    .option('--dry-run', 'Skip every POST; envelope echoes one `would` per --name.');
  attachMeta(cmd, meta);

  cmd.action(async (opts: AttachOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // ---- Validate inputs.
      if (opts.private === true && opts.public === true) {
        throw new ValidationError('--private and --public are mutually exclusive.', {
          hintNext: 'Pick one: --private OR --public.',
        });
      }
      const names = opts.name;
      if (names === undefined || names.length === 0) {
        throw new ValidationError('At least one --name is required.', {
          hintNext: 'Pass --name "Billable" (repeatable for multiple labels).',
        });
      }

      const projectId = opts.project!;
      const isPrivate: boolean = opts.public === true ? false : true;

      if (opts.dryRun === true) {
        for (const name of names) {
          emitDryRun(projectId, name, isPrivate, opts.hex, appConfig);
        }
        return;
      }

      // ---- Live fan-out.
      await runFanOut(projectId, names, isPrivate, opts.hex, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Per-name flows
 * ------------------------------------------------------------------------- */

function emitDryRun(
  projectId: number,
  name: string,
  isPrivate: boolean,
  color: string | undefined,
  appConfig: PartialAppConfig,
): void {
  const mode = appConfig.output.mode;
  const apiInput: AttachProjectLabelInput = {
    name,
    isPrivate,
    ...(color !== undefined ? { color } : {}),
  };
  const body = buildAttachProjectLabelBody(apiInput);

  const dryData: LabelsAttachData = {
    project_id: projectId,
    name,
    is_private: isPrivate,
    ...(color !== undefined ? { color } : {}),
  };
  const envelope = dryRunEnvelope({
    schema: SCHEMA,
    data: dryData,
    would: { method: 'POST', path: attachLabelPath(projectId), body },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  render(mode, envelope, (d) => renderLabelsAttachHuman(d));
}

async function runFanOut(
  projectId: number,
  names: readonly string[],
  isPrivate: boolean,
  color: string | undefined,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const client = await buildClient(appConfig, env);

  if (names.length === 1) {
    await runOneName(projectId, names[0]!, isPrivate, color, appConfig, client);
    return;
  }

  const exitAcc = new ExitCodeAccumulator();
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i]!;
    try {
      await runOneName(projectId, name, isPrivate, color, appConfig, client);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, projectId, name, mode);
      exitAcc.observe(typed.exitCode);
    }
  }

  if (exitAcc.value !== 0) {
    const { drainDispatcher, exitDeferred } = await import('../../errors/handle.js');
    await drainDispatcher();
    await exitDeferred(exitAcc.value);
  }
}

async function runOneName(
  projectId: number,
  name: string,
  isPrivate: boolean,
  color: string | undefined,
  appConfig: PartialAppConfig,
  client: HttpClient,
): Promise<void> {
  const mode = appConfig.output.mode;
  const apiInput: AttachProjectLabelInput = {
    name,
    isPrivate,
    ...(color !== undefined ? { color } : {}),
  };
  const body = buildAttachProjectLabelBody(apiInput);

  const result = await attachLabelToProject(client, projectId, {
    body,
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });

  const data: LabelsAttachData = {
    project_id: projectId,
    name,
    is_private: isPrivate,
    ...(color !== undefined ? { color } : {}),
  };
  const envelope: Envelope<LabelsAttachData> = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: result.raw.rateLimit.remaining,
      reset_at: result.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  render(mode, envelope, (d) => renderLabelsAttachHuman(d));
}

/* ---------------------------------------------------------------------------
 *  Helpers
 * ------------------------------------------------------------------------- */

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

function writeBatchError(
  err: BaseError,
  index: number,
  projectId: number,
  name: string,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    process.stdout.write(
      `Failed item ${index + 1} (project #${projectId}, name=${JSON.stringify(name)}): ${err.message}\n`,
    );
    return;
  }
  const httpStatus =
    'httpStatus' in err && typeof err.httpStatus === 'number' ? err.httpStatus : null;
  const requestId = 'requestId' in err && typeof err.requestId === 'string' ? err.requestId : null;
  const errors =
    'errors' in err && Array.isArray((err as { errors?: unknown }).errors)
      ? (err as { errors: string[] }).errors
      : undefined;
  const envelope = {
    schema: 'freelo.error/v1' as const,
    error: {
      code: err.code,
      message: err.message,
      ...(errors !== undefined && errors.length > 0 ? { errors } : {}),
      http_status: httpStatus,
      request_id: requestId,
      retryable: err.retryable,
      hint_next: err.hintNext ?? null,
      docs_url: null,
      context: { input_index: index, project_id: projectId, name },
    },
  };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function toBaseError(err: unknown): BaseError {
  if (err instanceof BaseError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ValidationError(message, {
    hintNext: 'Investigate the underlying error and retry the name.',
  });
}
