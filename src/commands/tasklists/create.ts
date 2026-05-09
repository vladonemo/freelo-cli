import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import {
  buildCreateTasklistBody,
  createTasklist,
  createTasklistPath,
} from '../../api/tasklists-create.js';
import { type CreateTasklistInput, type TasklistsCreateData } from '../../api/schemas/tasklist.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderTasklistsCreateHuman } from '../../ui/human/tasklists-create.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasklists.create/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.tasklists.create/v1';

type CreateOpts = {
  project?: number;
  name?: string;
  budget?: string;
  dryRun?: boolean;
};

/* ---------------------------------------------------------------------------
 *  Flag parsers — each throws ValidationError (BaseError, exit 2). NOT
 *  Commander's InvalidArgumentError, which falls through to exit 1
 *  (Calibration §1-2).
 * ------------------------------------------------------------------------- */

function parseProjectFlag(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--project must be a positive integer.', {
      hintNext: '--project is the numeric project id (e.g. from `freelo projects list`).',
    });
  }
  return n;
}

/**
 * Parse `--budget <str>`. Freelo wire format: a stringified amount in base
 * units (no decimal separator) where the last two digits are decimal places
 * — e.g. "100000" = 1000.00 of the project's currency.
 *
 * The CLI accepts the string verbatim — converting client-side risks float
 * precision drift. We only check shape: digits-only, non-empty.
 */
function parseBudgetFlag(raw: string): string {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new ValidationError('--budget must be a non-negative integer string (no separator).', {
      hintNext:
        '--budget is in base units, e.g. "100000" for 1000.00. The last two digits are decimals.',
    });
  }
  return trimmed;
}

export function registerCreate(
  tasklists: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = tasklists
    .command('create')
    .description('Create a new tasklist in a project.')
    .option(
      '--project <id>',
      'Project id to create the tasklist in (positive integer, required).',
      parseProjectFlag,
    )
    .option('--name <str>', 'Tasklist name (required, non-empty).')
    .option(
      '--budget <str>',
      'Budget in base units (no separator), e.g. "100000" for 1000.00. Stringified-currency.',
      parseBudgetFlag,
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
  if (opts.project === undefined) {
    throw new ValidationError('--project is required.', {
      hintNext: '--project is the numeric project id (e.g. from `freelo projects list`).',
    });
  }
  if (opts.name === undefined) {
    throw new ValidationError('--name is required.', {
      hintNext: '--name takes a non-empty tasklist name (e.g. --name "QA checklist").',
    });
  }
  const name = opts.name.trim();
  if (name.length === 0) {
    throw new ValidationError('--name cannot be empty.', {
      hintNext: '--name takes a non-empty tasklist name (e.g. --name "QA checklist").',
    });
  }
  opts.name = name;
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

  const projectId = opts.project!;
  const input: CreateTasklistInput = {
    projectId,
    name: opts.name!,
  };
  if (opts.budget !== undefined) input.budget = opts.budget;
  const body = buildCreateTasklistBody(input);

  // --- Dry-run: no HTTP call.
  if (opts.dryRun === true) {
    const data: TasklistsCreateData = {
      project_id: projectId,
      would: {
        method: 'POST',
        path: createTasklistPath(projectId),
        body,
      },
    };
    const envelope: Envelope<TasklistsCreateData> = {
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

  let result: Awaited<ReturnType<typeof createTasklist>>;
  try {
    result = await createTasklist(client, {
      projectId,
      body,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    throw rewriteApiHint(err);
  }

  const data: TasklistsCreateData = {
    project_id: projectId,
    tasklist: result.tasklist,
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
  writeEnvelope(envelope, mode);
}

/* ---------------------------------------------------------------------------
 *  Output
 * ------------------------------------------------------------------------- */

function writeEnvelope(
  envelope: Envelope<TasklistsCreateData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    process.stdout.write(`${renderTasklistsCreateHuman(envelope.data)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Map `FreeloApiError` thrown by `createTasklist` to a friendlier `hintNext`
 * for the well-known cases. Returns the original error unchanged for non-
 * FreeloApiError values and statuses we do not specialize.
 *
 * Spec 0047 §4.
 */
function rewriteApiHint(err: unknown): unknown {
  if (!(err instanceof FreeloApiError)) return err;

  if (err.httpStatus === 400) {
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: 'Server-side validation rejected the request; review the message and adjust flags.',
    });
  }
  if (err.httpStatus === 403) {
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: 'Account does not have permission to create tasklists in this project.',
    });
  }
  if (err.httpStatus === 404) {
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: 'Project not found, or your account does not have access.',
    });
  }
  return err;
}
