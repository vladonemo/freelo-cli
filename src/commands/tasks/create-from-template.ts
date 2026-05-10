import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import {
  buildCreateTaskFromTemplateBody,
  createTaskFromTemplate,
  createTaskFromTemplatePath,
} from '../../api/tasks-create-from-template.js';
import {
  type CreateTaskFromTemplateInput,
  type TasksCreateFromTemplateData,
} from '../../api/schemas/task-create-from-template.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderTasksCreateFromTemplateHuman } from '../../ui/human/tasks-create-from-template.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

/**
 * R39 (spec 0053) — `freelo tasks create-from-template <template_id>`.
 *
 * Sibling of `tasklists create-from-template` (R34, spec 0047). Same flag
 * family, slightly different body shape:
 *   - body field `task_id` (instead of `tasklist_id`)
 *   - response carries an embedded `tasklist: { id, name }` reference.
 *
 * Non-destructive (creates a new task). No `--yes` required. `--dry-run`
 * supported per the agent-safe-writes contract.
 */

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.create-from-template/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.tasks.create-from-template/v1';

type CreateOpts = {
  sourceTask?: number;
  targetProject?: number;
  targetTasklist?: number;
  dateStart?: string;
  worker?: number[];
  dryRun?: boolean;
};

/* ---------------------------------------------------------------------------
 *  Flag / arg parsers — each throws ValidationError (BaseError, exit 2). NOT
 *  Commander's InvalidArgumentError, which falls through to exit 1
 *  (Calibration §1-2).
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

function parsePositiveIntFlag(label: string, hint: string): (raw: string) => number {
  return (raw: string): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new ValidationError(`${label} must be a positive integer.`, { hintNext: hint });
    }
    return n;
  };
}

const parseSourceTaskFlag = parsePositiveIntFlag(
  '--source-task',
  '--source-task is the numeric id of the source task INSIDE the template; maps to body field `task_id`.',
);
const parseTargetProjectFlag = parsePositiveIntFlag(
  '--target-project',
  '--target-project is the numeric project id to land the copy in (omit to create a new project).',
);
const parseTargetTasklistFlag = parsePositiveIntFlag(
  '--target-tasklist',
  '--target-tasklist is the numeric id of an existing tasklist (in --target-project) to land the copy in.',
);

/**
 * Parse `--date-start <YYYY-MM-DD>` — same parser as spec 0047's
 * `parseDateStartFlag` (R34 `tasklists create-from-template`). Two checks:
 *   - regex `^\d{4}-\d{2}-\d{2}$` to catch typos like `2026/09/01`.
 *   - round-trip validation to catch nonsense calendar values like `2026-13-40`.
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
 * `previous = undefined`; subsequent calls pass the array. Mirrors R31 / spec 0047.
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
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = tasks
    .command('create-from-template <template_id>')
    .description('Copy a single task from a project template into a target project.')
    .option(
      '--source-task <id>',
      'Source task id INSIDE the template (required, positive integer). Maps to body field `task_id`.',
      parseSourceTaskFlag,
    )
    .option(
      '--target-project <id>',
      'Target project id (positive integer). Omit to land the copy in a freshly-created project.',
      parseTargetProjectFlag,
    )
    .option(
      '--target-tasklist <id>',
      'Existing tasklist id (positive integer) inside --target-project to land the copy in.',
      parseTargetTasklistFlag,
    )
    .option(
      '--date-start <YYYY-MM-DD>',
      'Anchor date for floating template due dates (e.g. "+3 days" → date+3). Maps to `preset_date_from`.',
      parseDateStartFlag,
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
 *  Flag validation
 * ------------------------------------------------------------------------- */

function validateFlags(opts: CreateOpts): void {
  if (opts.sourceTask === undefined) {
    throw new ValidationError('--source-task is required.', {
      hintNext:
        '--source-task is the numeric id of the source task INSIDE the template; maps to body field `task_id`.',
    });
  }
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

  const input: CreateTaskFromTemplateInput = {
    templateId,
    sourceTaskId: opts.sourceTask!,
  };
  if (opts.targetProject !== undefined) input.targetProjectId = opts.targetProject;
  if (opts.targetTasklist !== undefined) input.targetTasklistId = opts.targetTasklist;
  if (opts.dateStart !== undefined) input.dateStart = opts.dateStart;
  if (opts.worker !== undefined) input.workers = opts.worker;
  const body = buildCreateTaskFromTemplateBody(input);

  // --- Dry-run: no HTTP call.
  if (opts.dryRun === true) {
    const data: TasksCreateFromTemplateData = {
      template_id: templateId,
      would: {
        method: 'POST',
        path: createTaskFromTemplatePath(templateId),
        body,
      },
    };
    const envelope: Envelope<TasksCreateFromTemplateData> = {
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

  let result: Awaited<ReturnType<typeof createTaskFromTemplate>>;
  try {
    result = await createTaskFromTemplate(client, {
      templateId,
      body,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    throw rewriteApiHint(err);
  }

  const data: TasksCreateFromTemplateData = {
    template_id: templateId,
    task: result.task,
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
  envelope: Envelope<TasksCreateFromTemplateData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    process.stdout.write(`${renderTasksCreateFromTemplateHuman(envelope.data)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Map `FreeloApiError` thrown by `createTaskFromTemplate` to a friendlier
 * `hintNext` for the well-known cases. Returns the original error unchanged
 * for non-FreeloApiError values and statuses we do not specialize.
 *
 * Specialized cases (per spec 0053 §2.7):
 *   - 400 mentioning `task_id`            → source-task-not-in-template hint.
 *   - 400 mentioning `users_ids`          → workers-not-in-template hint.
 *   - 400 mentioning `target_project_id`  → target-project-not-accessible hint.
 *   - 400 mentioning `target_tasklist_id` → target-tasklist-not-in-project hint.
 *   - 400 generic                         → server-side validation hint.
 *   - 403                                 → permission hint.
 *   - 404                                 → template-not-found hint.
 */
function rewriteApiHint(err: unknown): unknown {
  if (!(err instanceof FreeloApiError)) return err;

  if (err.httpStatus === 400) {
    const haystack = [err.message, ...err.errors].join(' ');
    let hintNext: string;
    if (/task_id/i.test(haystack)) {
      hintNext =
        'Source task id must reference a task INSIDE the template referenced by <template_id>.';
    } else if (/users_ids/i.test(haystack)) {
      hintNext =
        'Worker ids must be members of the template; check `freelo projects show <template>`.';
    } else if (/target_project_id/i.test(haystack)) {
      hintNext = 'Target project id must reference a project the caller can access.';
    } else if (/target_tasklist_id/i.test(haystack)) {
      hintNext = 'Target tasklist id must reference a tasklist inside the target project.';
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
