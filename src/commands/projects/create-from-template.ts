import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import {
  buildCreateProjectFromTemplateBody,
  createProjectFromTemplate,
  createProjectFromTemplatePath,
} from '../../api/projects-create-from-template.js';
import {
  PROJECT_CURRENCY_VALUES,
  PROJECT_LAYOUT_VALUES,
  type CreateProjectFromTemplateInput,
  type ProjectCurrency,
  type ProjectLayout,
  type ProjectsCreateFromTemplateData,
} from '../../api/schemas/project.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderProjectsCreateFromTemplateHuman } from '../../ui/human/projects-create-from-template.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.projects.create-from-template/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.projects.create-from-template/v1';

type CreateOpts = {
  name?: string;
  ownerId?: number;
  currency?: ProjectCurrency;
  dateStart?: string;
  layout?: ProjectLayout;
  worker?: number[];
  dryRun?: boolean;
};

/* ---------------------------------------------------------------------------
 *  Flag / arg parsers
 *
 *  Each parser throws `ValidationError` (BaseError, exit 2) — NOT Commander's
 *  `InvalidArgumentError`, which would map to exit 1. Calibration §1-2.
 * ------------------------------------------------------------------------- */

function parseTemplateIdArg(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('<template_id> must be a positive integer.', {
      hintNext:
        '<template_id> is the numeric id of a project template (state=3). Run `freelo projects list --scope templates` to find one.',
    });
  }
  return n;
}

function parseOwnerIdFlag(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--owner-id must be a positive integer.', {
      hintNext: '--owner-id is the numeric user id (e.g. from `freelo users list`).',
    });
  }
  return n;
}

/**
 * Parse `--currency <code>`. Accepts mixed-case (R29 decision 5); uppercases
 * on the way in. Validates against the OpenAPI enum.
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

/**
 * Parse `--layout <rows|kanban>`. Mixed-case accepted; lowercased on the way
 * in (decision 7 — mirrors `--currency` ergonomic policy).
 */
function parseLayoutFlag(raw: string): ProjectLayout {
  const lower = raw.trim().toLowerCase();
  if (!(PROJECT_LAYOUT_VALUES as readonly string[]).includes(lower)) {
    throw new ValidationError(`--layout must be one of: ${PROJECT_LAYOUT_VALUES.join(', ')}.`, {
      hintNext: `--layout valid values: ${PROJECT_LAYOUT_VALUES.join(', ')}.`,
    });
  }
  return lower as ProjectLayout;
}

/**
 * Parse `--date-start <YYYY-MM-DD>`. Two checks (decision 6):
 *   - regex `^\d{4}-\d{2}-\d{2}$` to catch typos like `2026/09/01`.
 *   - `Date.parse` finite-ness to catch nonsense calendar values like `2026-13-40`.
 *
 * The wire format is plain ISO date (no time component).
 */
function parseDateStartFlag(raw: string): string {
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new ValidationError('--date-start must be in YYYY-MM-DD format.', {
      hintNext: '--date-start example: 2026-09-01.',
    });
  }
  const parsed = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError('--date-start is not a valid calendar date.', {
      hintNext: '--date-start must be an ISO-8601 calendar date (YYYY-MM-DD).',
    });
  }
  // Round-trip guard: `Date.parse('2026-13-40')` is NaN, but `2026-02-30`
  // (Feb 30) parses to Mar 2. Compare the round-trip ISO date.
  const isoBack = new Date(parsed).toISOString().slice(0, 10);
  if (isoBack !== trimmed) {
    throw new ValidationError('--date-start is not a valid calendar date.', {
      hintNext: '--date-start must be an ISO-8601 calendar date (YYYY-MM-DD).',
    });
  }
  return trimmed;
}

/**
 * Parse `--worker <id>` — repeatable. Commander invokes this once per flag
 * occurrence, accumulating into the previous value. The first call passes
 * `previous = undefined`; subsequent calls pass the array.
 */
function parseWorkerFlag(raw: string, previous: number[] | undefined): number[] {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--worker must be a positive integer.', {
      hintNext: '--worker is the numeric user id; repeat the flag for multiple workers.',
    });
  }
  return previous === undefined ? [n] : [...previous, n];
}

export function registerCreateFromTemplate(
  projects: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = projects
    .command('create-from-template <template_id>')
    .description('Create a new project by cloning a project template (state=3).')
    .option('--name <str>', 'New project name (required, non-empty).')
    .option(
      '--owner-id <id>',
      'Numeric user id assigned as project owner. Defaults to the authenticated caller.',
      parseOwnerIdFlag,
    )
    .option(
      '--currency <code>',
      `Currency for budgets/invoicing. One of: ${PROJECT_CURRENCY_VALUES.join(', ')}. Omit to let the server derive from caller locale.`,
      parseCurrencyFlag,
    )
    .option(
      '--date-start <YYYY-MM-DD>',
      'Anchor date for floating template due dates (e.g. "+3 days" → date+3).',
      parseDateStartFlag,
    )
    .option(
      '--layout <rows|kanban>',
      `Initial board layout. One of: ${PROJECT_LAYOUT_VALUES.join(', ')}. Defaults to rows server-side.`,
      parseLayoutFlag,
    )
    .option(
      '--worker <id>',
      'User id from the template member list to invite. Repeat for multiple workers.',
      parseWorkerFlag,
    )
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (templateIdRaw: string, opts: CreateOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      const templateId = parseTemplateIdArg(templateIdRaw);
      validateFlags(opts);
      await runCreateFromTemplate(templateId, opts, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Flag validation (synchronous; runs before any HTTP call)
 * ------------------------------------------------------------------------- */

function validateFlags(opts: CreateOpts): void {
  // `--name` is required at the CLI (decision 1) — even though the server
  // allows omission (it falls back to the template name). Predictable agent
  // output > five characters of typing. We validate here (rather than via
  // Commander's `requiredOption`) so missing `--name` surfaces as
  // `ValidationError` (exit 2) instead of Commander's `CommanderError` which
  // falls through to `INTERNAL_ERROR` (exit 1). Calibration §1-2.
  if (opts.name === undefined) {
    throw new ValidationError('--name is required.', {
      hintNext: '--name takes a non-empty new-project name (e.g. --name "Acme Q3").',
    });
  }
  const name = opts.name.trim();
  if (name.length === 0) {
    throw new ValidationError('--name cannot be empty.', {
      hintNext: '--name takes a non-empty new-project name (e.g. --name "Acme Q3").',
    });
  }
  // `opts.name` may have leading/trailing whitespace — overwrite with trimmed.
  opts.name = name;
}

/* ---------------------------------------------------------------------------
 *  Live + dry-run dispatch
 * ------------------------------------------------------------------------- */

async function runCreateFromTemplate(
  templateId: number,
  opts: CreateOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;

  // Build the wire body. `opts.name` was trimmed in `validateFlags`.
  // `opts.currency` is uppercased, `opts.layout` is lowercased, `opts.dateStart`
  // is regex-validated — all by their respective flag parsers.
  const input: CreateProjectFromTemplateInput = {
    templateId,
    name: opts.name!,
  };
  if (opts.ownerId !== undefined) input.ownerId = opts.ownerId;
  if (opts.currency !== undefined) input.currency = opts.currency;
  if (opts.dateStart !== undefined) input.dateStart = opts.dateStart;
  if (opts.layout !== undefined) input.layout = opts.layout;
  if (opts.worker !== undefined) input.workers = opts.worker;
  const body = buildCreateProjectFromTemplateBody(input);

  // --- Dry-run: no HTTP call.
  if (opts.dryRun === true) {
    const data: ProjectsCreateFromTemplateData = {
      template_id: templateId,
      would: {
        method: 'POST',
        path: createProjectFromTemplatePath(templateId),
        body,
      },
    };
    const envelope: Envelope<ProjectsCreateFromTemplateData> = {
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

  let result: Awaited<ReturnType<typeof createProjectFromTemplate>>;
  try {
    result = await createProjectFromTemplate(client, {
      templateId,
      body,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    throw rewriteApiHint(err);
  }

  const data: ProjectsCreateFromTemplateData = {
    template_id: templateId,
    project: result.project,
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
  envelope: Envelope<ProjectsCreateFromTemplateData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    process.stdout.write(`${renderProjectsCreateFromTemplateHuman(envelope.data)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Map a `FreeloApiError` thrown by `createProjectFromTemplate` to a friendlier
 * `hintNext` for the well-known cases. Returns the original error unchanged
 * for non-FreeloApiError values and statuses we do not specialize.
 *
 * Specialized cases (per OpenAPI :759-830 + §4 of spec 0044):
 *   - 400 with `project_owner_id` mention → owner hint (mirrors R29).
 *   - 400 with `users_ids` mention → workers-not-in-template hint.
 *   - 400 generic → server-side validation hint.
 *   - 403 → permission hint.
 *   - 404 → template-not-found hint.
 *
 * Spec 0044 §4.
 */
function rewriteApiHint(err: unknown): unknown {
  if (!(err instanceof FreeloApiError)) return err;

  if (err.httpStatus === 400) {
    const haystack = [err.message, ...err.errors].join(' ');
    let hintNext: string;
    if (/project_owner_id/i.test(haystack)) {
      hintNext = 'Confirm the user id; the owner must be an owner-eligible user in your account.';
    } else if (/users_ids/i.test(haystack)) {
      hintNext =
        'Worker ids must be members of the template; check `freelo projects show <template>`.';
    } else {
      hintNext =
        'Server-side validation rejected the request; review the message and adjust flags.';
    }
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext,
    });
  }
  if (err.httpStatus === 403) {
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: 'Account does not have permission to use this template.',
    });
  }
  if (err.httpStatus === 404) {
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext:
        'Template not found. Run `freelo projects list --scope templates` to list valid ids.',
    });
  }
  return err;
}
