/**
 * `freelo taskchecks delete <id>...` (M03, spec 0066).
 *
 * `DELETE /taskcheck/{taskcheck_id}` (yaml :2156-2171) — soft-deletes a
 * *simple* checklist item. Structurally a sibling of
 * `src/commands/files/delete.ts` (M07) and `src/commands/comments/delete.ts`
 * (M01): same batch surfaces, same confirmation gate, same "a 404 is an error"
 * stance — reached, here, by a different argument (see `shared.ts`
 * `rewriteTaskcheckNotFound` and spec 0066 §5.1).
 *
 * **No `--notify-author`.** The operation declares no `requestBody` at all
 * (yaml :2156-2171), unlike `edit` and `finish`. The roadmap claimed all four
 * endpoints take it; the OpenAPI contract disagrees and wins (decision 3).
 * This command sends no body.
 *
 * Output schema: `freelo.taskchecks.delete/v1`.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { type HttpClient } from '../../api/client.js';
import { deleteTaskcheck, deleteTaskcheckPath } from '../../api/taskchecks.js';
import { type TaskchecksDeleteData } from '../../api/schemas/taskcheck.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderTaskchecksDeleteHuman } from '../../ui/human/taskchecks-delete.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import { confirmDestructive } from '../../lib/confirm.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';
import {
  buildClient,
  collectTaskcheckId,
  parseIdsFlag,
  resolveYesFlag,
  rewriteTaskcheckNotFound,
  toBaseError,
  validateInputSources,
  writeBatchError,
} from './shared.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.taskchecks.delete/v1',
  destructive: true,
};

const SCHEMA: SchemaString = 'freelo.taskchecks.delete/v1';

type DeleteOpts = {
  ids?: string;
  stdin?: true;
  dryRun?: true;
};

/**
 * Per-line NDJSON schema. `.strict()` so a typo'd key (`{"taskcheck_id": …}`)
 * surfaces as a per-line error rather than being silently ignored.
 */
const BatchLineSchema = z
  .object({
    id: z.number().int().min(1, 'id must be a positive integer.'),
  })
  .strict();

export function registerDelete(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = parent
    .command('delete')
    .description(
      'Delete one or more simple checklist items by id. Soft-delete — the row is marked deleted, and there is no undelete endpoint. Destructive: requires --yes (non-TTY) or interactive confirmation (TTY). Requires a simple (non-smart) checklist item ids; a smart subtask id returns 404 here — delete those with `freelo tasks delete`. A 404 is always reported as an error, never as an idempotent already-deleted success.',
    )
    .argument('[id...]', 'One or more taskcheck ids (positional).', collectTaskcheckId)
    .option(
      '--ids <list>',
      'Comma- or space-separated list of taskcheck ids (mutex with positional <id> and --stdin).',
    )
    .option(
      '--stdin',
      'Read NDJSON from stdin (one `{"id": <int>}` per line). Mutex with positional and --ids.',
    )
    .option(
      '--dry-run',
      'Skip the DELETE per id. No confirmation prompt fires. Envelope reflects what would have been called.',
    );
  // NOTE: `--yes` / `-y` is the **global** flag, read via `resolveYesFlag`.
  attachMeta(cmd, meta);

  cmd.action(async (ids: number[] | undefined, opts: DeleteOpts, cmdCtx: Command) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;
    const yes = resolveYesFlag(cmdCtx);

    try {
      validateInputSources(ids, opts);

      if (opts.stdin === true) {
        await runBatchFromStdin(opts, yes, appConfig, env);
        return;
      }

      const resolved =
        ids !== undefined && ids.length > 0
          ? ids
          : opts.ids !== undefined
            ? parseIdsFlag(opts.ids)
            : [];

      if (resolved.length === 0) return; // silent success (batch convention)

      await runIdList(resolved, opts, yes, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

async function runIdList(
  ids: readonly number[],
  opts: DeleteOpts,
  yes: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;

  await confirmDestructive({
    promptMessage: confirmMessage(ids.length),
    yes,
    dryRun: opts.dryRun === true,
  });

  const client = opts.dryRun === true ? null : await buildClient(appConfig, env);

  if (ids.length === 1) {
    await runOneId(ids[0]!, opts, appConfig, client, undefined);
    return;
  }

  const exitAcc = new ExitCodeAccumulator();
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i]!;
    try {
      await runOneId(id, opts, appConfig, client, undefined);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, id, mode, false);
      exitAcc.observe(typed.exitCode);
    }
  }

  if (exitAcc.value !== 0) {
    const { drainDispatcher, exitDeferred } = await import('../../errors/handle.js');
    await drainDispatcher();
    await exitDeferred(exitAcc.value);
  }
}

async function runBatchFromStdin(
  opts: DeleteOpts,
  yes: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const exitAcc = new ExitCodeAccumulator();

  const allLines: string[] = [];
  for await (const line of iterateLines(process.stdin)) {
    allLines.push(line);
  }

  if (allLines.length === 0) return; // empty stdin → silent success

  // Confirm AFTER buffering (R13 decision 7) so empty stdin never prompts.
  await confirmDestructive({
    promptMessage: confirmMessage(allLines.length),
    yes,
    dryRun: opts.dryRun === true,
  });

  let lazyClient: HttpClient | undefined;
  const getClient = async (): Promise<HttpClient> => {
    lazyClient ??= await buildClient(appConfig, env);
    return lazyClient;
  };

  for (let i = 0; i < allLines.length; i += 1) {
    const line = allLines[i]!;
    const result = parseNdjsonLine(line, i, BatchLineSchema);
    if (!result.ok) {
      writeBatchError(result.error, i, null, mode, true);
      exitAcc.observe(result.error.exitCode);
      continue;
    }
    const id = result.value.id;
    try {
      const client = opts.dryRun === true ? null : await getClient();
      await runOneId(id, opts, appConfig, client, i);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, id, mode, true);
      exitAcc.observe(typed.exitCode);
    }
  }

  if (exitAcc.value !== 0) {
    const { drainDispatcher, exitDeferred } = await import('../../errors/handle.js');
    await drainDispatcher();
    await exitDeferred(exitAcc.value);
  }
}

async function runOneId(
  id: number,
  opts: DeleteOpts,
  appConfig: PartialAppConfig,
  client: HttpClient | null,
  lineIndex: number | undefined,
): Promise<void> {
  const mode = appConfig.output.mode;

  if (opts.dryRun === true) {
    const data: TaskchecksDeleteData = {
      taskcheck_id: id,
      current_state: 'deleted',
      would: { method: 'DELETE', path: deleteTaskcheckPath(id), body: {} },
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope: Envelope<TaskchecksDeleteData> = { schema: SCHEMA, data, dry_run: true };
    if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
    writeEnvelope(envelope, mode);
    return;
  }

  if (client === null) {
    throw new ValidationError('Internal: HTTP client missing for live delete.', {
      hintNext: 'This is a programming bug — please file an issue.',
    });
  }

  let result;
  try {
    result = await deleteTaskcheck(client, id, {
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    // Never converts an error into a success — spec 0066 §5.1.
    throw rewriteTaskcheckNotFound(err, id, 'tasks delete');
  }

  const data: TaskchecksDeleteData = {
    taskcheck_id: id,
    current_state: 'deleted',
    ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
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

function confirmMessage(count: number): string {
  if (count === 1) return 'Delete 1 checklist item?';
  return `Delete ${count} checklist items?`;
}

function writeEnvelope(
  envelope: Envelope<TaskchecksDeleteData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    process.stdout.write(`${renderTaskchecksDeleteHuman(envelope.data)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
