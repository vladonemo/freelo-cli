import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import {
  buildCreateProjectBody,
  createProject,
  createProjectPath,
} from '../../api/projects-create.js';
import {
  PROJECT_CURRENCY_VALUES,
  type CreateProjectInput,
  type ProjectCurrency,
  type ProjectsCreateData,
} from '../../api/schemas/project.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderProjectsCreateHuman } from '../../ui/human/projects-create.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.projects.create/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.projects.create/v1';

type CreateOpts = {
  name?: string;
  currency?: ProjectCurrency;
  projectOwnerId?: number;
  dryRun?: boolean;
};

/**
 * Parse `--project-owner-id <n>`. Throws `ValidationError` (BaseError, exit 2)
 * — NOT Commander's `InvalidArgumentError`, which would map to exit 1.
 * Calibration §1-2.
 */
function parseProjectOwnerIdFlag(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--project-owner-id must be a positive integer.', {
      hintNext: '--project-owner-id is the numeric user id (e.g. from `freelo users list`).',
    });
  }
  return n;
}

/**
 * Parse `--currency <code>`. Accepts mixed-case (decision 5); uppercases on
 * the way in. Validates against the OpenAPI enum (decision 2).
 */
function parseCurrencyFlag(raw: string): ProjectCurrency {
  const upper = raw.trim().toUpperCase();
  if (!(PROJECT_CURRENCY_VALUES as readonly string[]).includes(upper)) {
    throw new ValidationError(`--currency must be one of: ${PROJECT_CURRENCY_VALUES.join(', ')}.`, {
      hintNext: `--currency valid values: ${PROJECT_CURRENCY_VALUES.join(', ')}.`,
    });
  }
  return upper as ProjectCurrency;
}

export function registerCreate(
  projects: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = projects
    .command('create')
    .description('Create a new project.')
    .option('--name <str>', 'Project name (required, non-empty).')
    .option(
      '--currency <code>',
      `Currency for budgets/invoicing (required). One of: ${PROJECT_CURRENCY_VALUES.join(', ')}.`,
      parseCurrencyFlag,
    )
    .option(
      '--project-owner-id <id>',
      'Numeric user id assigned as project owner. Defaults to the authenticated caller.',
      parseProjectOwnerIdFlag,
    )
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (opts: CreateOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      validateFlags(opts);
      await runCreate(opts, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Flag validation
 * ------------------------------------------------------------------------- */

function validateFlags(opts: CreateOpts): void {
  // `--name` and `--currency` are required; we validate them here (rather than
  // via Commander's `requiredOption`) so a missing value surfaces as
  // `ValidationError` (exit 2) instead of Commander's `CommanderError` which
  // falls through to `INTERNAL_ERROR` (exit 1). Calibration §1-2.
  if (opts.name === undefined) {
    throw new ValidationError('--name is required.', {
      hintNext: '--name takes a non-empty project name (e.g. --name "Q3 onboarding").',
    });
  }
  const name = opts.name.trim();
  if (name.length === 0) {
    throw new ValidationError('--name cannot be empty.', {
      hintNext: '--name takes a non-empty project name (e.g. --name "Q3 onboarding").',
    });
  }
  // `opts.name` may have leading/trailing whitespace — overwrite with trimmed.
  opts.name = name;

  if (opts.currency === undefined) {
    throw new ValidationError(
      `--currency is required: one of ${PROJECT_CURRENCY_VALUES.join(', ')}.`,
      {
        hintNext: `--currency valid values: ${PROJECT_CURRENCY_VALUES.join(', ')}.`,
      },
    );
  }
}

/* ---------------------------------------------------------------------------
 *  Live + dry-run dispatch
 * ------------------------------------------------------------------------- */

async function runCreate(
  opts: CreateOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;

  // Build the wire body. `opts.currency` is already a validated `ProjectCurrency`
  // (uppercased by `parseCurrencyFlag`). `opts.name` was trimmed in
  // `validateFlags`. Commander guarantees both are present (`requiredOption`).
  const input: CreateProjectInput = {
    name: opts.name!,
    currency: opts.currency!,
  };
  if (opts.projectOwnerId !== undefined) {
    input.projectOwnerId = opts.projectOwnerId;
  }
  const body = buildCreateProjectBody(input);

  // --- Dry-run: no HTTP call.
  if (opts.dryRun === true) {
    const data: ProjectsCreateData = {
      would: {
        method: 'POST',
        path: createProjectPath,
        body,
      },
    };
    const envelope: Envelope<ProjectsCreateData> = {
      schema: SCHEMA,
      data,
      dry_run: true,
    };
    if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
    writeEnvelope(envelope, mode);
    return;
  }

  // --- Live POST.
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

  let result: Awaited<ReturnType<typeof createProject>>;
  try {
    result = await createProject(client, {
      body,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    throw rewriteApiHint(err);
  }

  const data: ProjectsCreateData = { project: result.project };
  const envelope = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: result.raw.rateLimit.remaining,
      reset_at: result.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  writeEnvelope(envelope, mode);
}

/* ---------------------------------------------------------------------------
 *  Output
 * ------------------------------------------------------------------------- */

function writeEnvelope(
  envelope: Envelope<ProjectsCreateData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    // R29 never emits an envelope `notice` — every response is either a
    // create-success or a dry-run "would". A future slice that adds notices
    // can lift this from `tasks/create.ts` (single line append).
    process.stdout.write(`${renderProjectsCreateHuman(envelope.data)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Map a `FreeloApiError` thrown by `createProject` to a friendlier `hintNext`
 * for the well-known cases. Returns the original error unchanged for non-
 * FreeloApiError values and statuses we do not specialize.
 *
 * Spec 0042 §4.
 */
function rewriteApiHint(err: unknown): unknown {
  if (!(err instanceof FreeloApiError)) return err;

  // 400 — most commonly "project_owner_id X is not valid" (per OpenAPI :204).
  // The phrase appears in `err.errors[]` (from the JSON body's `errors`
  // array), not on `err.message` (which is the synthesized "Freelo API error
  // (HTTP 400)." string). Scan both.
  if (err.httpStatus === 400) {
    const haystack = [err.message, ...err.errors].join(' ');
    const ownerHinted = /project_owner_id/i.test(haystack);
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: ownerHinted
        ? 'Confirm the user id; the owner must be an owner-eligible user in your account.'
        : 'Server-side validation rejected the request; review the message and adjust flags.',
    });
  }
  if (err.httpStatus === 403) {
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: 'Account does not have permission to create projects.',
    });
  }
  return err;
}
