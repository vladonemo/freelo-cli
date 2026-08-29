/**
 * `freelo taskchecks edit <id>` (M03, spec 0066).
 *
 * `POST /taskcheck/{taskcheck_id}` (yaml :2118-2155) — rename a *simple*
 * checklist item and/or (re)assign its worker.
 *
 * **The edit surface is deliberately tiny.** The endpoint accepts only `name`
 * and `worker`; `priority_enum`, `priority`, `due_date` and `due_date_end`
 * return 400 (yaml :2124). R10's `tasks edit` flag set is NOT reused — a user
 * who needs those fields has a smart subtask and should run `freelo tasks edit`.
 *
 * **Single id, no batch surfaces** (decision 6): the per-item payload differs
 * per item, so `--ids` would mean "rename N items to the same string", which is
 * not a real workflow. `delete`/`finish`/`reopen` carry no payload and do batch.
 *
 * Output schema: `freelo.taskchecks.edit/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { type HttpClient } from '../../api/client.js';
import {
  buildEditTaskcheckBody,
  editTaskcheck,
  editTaskcheckPath,
  isEmptyEditTaskcheckBody,
} from '../../api/taskchecks.js';
import { type EditTaskcheckInput, type TaskchecksEditData } from '../../api/schemas/taskcheck.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderTaskchecksEditHuman } from '../../ui/human/taskchecks-edit.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';
import {
  buildClient,
  parseTaskcheckId,
  rewriteTaskcheckNotFound,
  TASKCHECK_ID_HINT,
} from './shared.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.taskchecks.edit/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.taskchecks.edit/v1';

type EditOpts = {
  name?: string;
  worker?: number;
  clearWorker?: true;
  notifyAuthor?: true;
  dryRun?: true;
};

/**
 * Parse `--worker`. Same positive-integer *rule* as `parseTaskcheckId`, but a
 * deliberately different **hint**: `--worker` takes a Freelo **user** id, not a
 * `tasks_checks.id`, so pointing the user at `freelo subtasks list` here would
 * send them to look up the wrong thing entirely.
 */
function parseWorkerId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--worker must be a positive integer.', {
      hintNext:
        '--worker takes a Freelo user id (not a taskcheck id). Use --clear-worker to unassign instead.',
    });
  }
  return n;
}

export function registerEdit(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = parent
    .command('edit')
    .description(
      'Rename a simple checklist item and/or (re)assign its worker. Only --name and --worker are editable — this endpoint rejects priority and due dates with a 400, so those flags are not offered. Requires a simple (non-smart) checklist item id (`tasks_checks.id`); a smart subtask id returns 404 here — edit those with `freelo tasks edit`.',
    )
    .argument('<id>', 'Taskcheck id (`tasks_checks.id`) of a simple checklist item.', (raw) =>
      parseTaskcheckId('<id>', raw),
    )
    .option('--name <str>', 'New name for the checklist item.')
    .option(
      '--worker <id>',
      'Assign a worker by user id. Mutex with --clear-worker.',
      parseWorkerId,
    )
    .option('--clear-worker', 'Unassign the worker (sends `worker: null`). Mutex with --worker.')
    .option(
      '--notify-author',
      'Keep yourself in the notification recipients even though you triggered the change.',
    )
    .option('--dry-run', 'Skip the POST. Envelope reflects what would have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (id: number, opts: EditOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      const input = validateAndBuildInput(opts);
      await runEdit(id, input, opts, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Validation (spec 0066 §4.1 / §7)
 * ------------------------------------------------------------------------- */

function validateAndBuildInput(opts: EditOpts): EditTaskcheckInput {
  if (opts.worker !== undefined && opts.clearWorker === true) {
    throw new ValidationError('--worker and --clear-worker are mutually exclusive.', {
      hintNext: 'Pass --worker <id> to assign someone, or --clear-worker to unassign.',
    });
  }
  if (opts.name !== undefined && opts.name.trim().length === 0) {
    throw new ValidationError('--name must not be empty.', {
      hintNext: 'Pass a non-empty name, or omit --name to leave it unchanged.',
    });
  }

  const input: EditTaskcheckInput = {
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.worker !== undefined ? { worker: opts.worker } : {}),
    ...(opts.clearWorker === true ? { clearWorker: true as const } : {}),
    ...(opts.notifyAuthor === true ? { notifyAuthor: true as const } : {}),
  };

  // `notify_author` alone is a modifier on a change with nothing to modify, and
  // the endpoint's `requestBody` is `required: true` — so refuse rather than
  // POST an effectively empty body.
  if (isEmptyEditTaskcheckBody(buildEditTaskcheckBody(input))) {
    throw new ValidationError('Nothing to change.', {
      hintNext: `Pass at least one of --name, --worker or --clear-worker. Only those fields are editable on a simple checklist item. ${TASKCHECK_ID_HINT}`,
    });
  }

  return input;
}

/** Which CLI-level fields were sent — echoed in the envelope for agents. */
function appliedChanges(input: EditTaskcheckInput): TaskchecksEditData['applied_changes'] {
  const out: TaskchecksEditData['applied_changes'] = [];
  if (input.name !== undefined) out.push('name');
  if (input.worker !== undefined) out.push('worker');
  else if (input.clearWorker === true) out.push('clear_worker');
  return out;
}

/* ---------------------------------------------------------------------------
 *  Flow
 * ------------------------------------------------------------------------- */

async function runEdit(
  id: number,
  input: EditTaskcheckInput,
  opts: EditOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const body = buildEditTaskcheckBody(input);
  const notifyAuthor = input.notifyAuthor === true;

  if (opts.dryRun === true) {
    // Dry-run never resolves credentials — there is no wire call to authenticate.
    const data: TaskchecksEditData = {
      taskcheck_id: id,
      applied_changes: appliedChanges(input),
      notify_author: notifyAuthor,
      would: { method: 'POST', path: editTaskcheckPath(id), body },
    };
    const envelope: Envelope<TaskchecksEditData> = { schema: SCHEMA, data, dry_run: true };
    if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
    writeEnvelope(envelope, mode);
    return;
  }

  const client: HttpClient = await buildClient(appConfig, env);

  let result;
  try {
    result = await editTaskcheck(client, {
      taskcheckId: id,
      body,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    throw rewriteTaskcheckNotFound(err, id, 'tasks edit');
  }

  const data: TaskchecksEditData = {
    taskcheck_id: id,
    applied_changes: appliedChanges(input),
    notify_author: notifyAuthor,
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

function writeEnvelope(
  envelope: Envelope<TaskchecksEditData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    process.stdout.write(`${renderTaskchecksEditHuman(envelope.data)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
