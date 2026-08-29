/**
 * Shared command logic for `freelo taskchecks finish` and
 * `freelo taskchecks reopen` (M03, spec 0066).
 *
 * Both have identical surfaces (variadic `<id>...` + `--ids` + `--stdin` +
 * `--dry-run`) and identical batch flow; only the verb — and therefore the
 * wire path, the envelope schema string and the resulting state — differ.
 * Mirrors `src/commands/tasks/transition.ts` (R11), with two deliberate
 * divergences documented in spec 0066 §5:
 *
 *   1. **No pre-check GET and no `already_in_target_state`.** R11 reads
 *      `GET /task/{id}` to report prior state. There is no
 *      `GET /taskcheck/{id}`, and a taskcheck id does not reveal its parent
 *      task's id, so prior state is unobservable. The CLI does not fabricate
 *      it — the field is absent from the envelope entirely (decision 5).
 *   2. **`--notify-author` on `finish` only.** `POST /taskcheck/{id}/finish`
 *      declares an optional `requestBody` carrying it (yaml :2183-2197);
 *      `POST /taskcheck/{id}/activate` declares no `requestBody` at all
 *      (yaml :2206-2222), so `reopen` sends no body (decision 3).
 *
 * Neither verb is confirmation-gated: each is exactly reversible by the other.
 *
 * Output schemas: `freelo.taskchecks.finish/v1`, `freelo.taskchecks.reopen/v1`.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { type HttpClient } from '../../api/client.js';
import {
  transitionTaskcheck,
  transitionTaskcheckPath,
  type TaskcheckVerb,
} from '../../api/taskchecks.js';
import { type TaskchecksTransitionData } from '../../api/schemas/taskcheck.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderTaskchecksTransitionHuman } from '../../ui/human/taskchecks-transition.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta } from '../../lib/introspect.js';
import {
  buildClient,
  collectTaskcheckId,
  parseIdsFlag,
  rewriteTaskcheckNotFound,
  toBaseError,
  validateInputSources,
  writeBatchError,
} from './shared.js';

type TransitionOpts = {
  ids?: string;
  stdin?: true;
  notifyAuthor?: true;
  dryRun?: true;
};

type VerbWiring = {
  verb: TaskcheckVerb;
  schema: SchemaString;
  /** State the verb moves the item INTO. Derived from the verb — the 200 body carries none. */
  targetState: TaskchecksTransitionData['current_state'];
  /** Only `finish` has a request body on the wire (decision 3). */
  supportsNotifyAuthor: boolean;
  /** The `freelo tasks …` command to point at when the id turns out to be smart. */
  smartAlternative: string;
  description: string;
};

const FINISH: VerbWiring = {
  verb: 'finish',
  schema: 'freelo.taskchecks.finish/v1',
  targetState: 'finished',
  supportsNotifyAuthor: true,
  smartAlternative: 'tasks finish',
  description:
    'Mark one or more simple checklist items as finished. Requires simple (non-smart) checklist item ids (`tasks_checks.id`); a smart subtask id returns 404 here — finish those with `freelo tasks finish`. The CLI cannot read a checklist item back (the API has no GET for one), so it does not report whether the item was already finished.',
};

const REOPEN: VerbWiring = {
  verb: 'reopen',
  schema: 'freelo.taskchecks.reopen/v1',
  targetState: 'active',
  supportsNotifyAuthor: false,
  smartAlternative: 'tasks reopen',
  description:
    'Move one or more finished simple checklist items back to active (wire: `/activate`). Requires simple (non-smart) checklist item ids; a smart subtask id returns 404 here — reopen those with `freelo tasks reopen`. No --notify-author: this endpoint declares no request body.',
};

const BatchLineSchema = z
  .object({
    id: z.number().int().min(1, 'id must be a positive integer.'),
  })
  .strict();

export function registerFinish(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  registerVerb(parent, getConfig, env, FINISH);
}

export function registerReopen(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  registerVerb(parent, getConfig, env, REOPEN);
}

function registerVerb(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
  wiring: VerbWiring,
): void {
  const cmd = parent
    .command(wiring.verb)
    .description(wiring.description)
    .argument('[id...]', 'One or more taskcheck ids (positional).', collectTaskcheckId)
    .option(
      '--ids <list>',
      'Comma- or space-separated list of taskcheck ids (mutex with positional <id> and --stdin).',
    )
    .option(
      '--stdin',
      'Read NDJSON from stdin (one `{"id": <int>}` per line). Mutex with positional and --ids.',
    )
    .option('--dry-run', 'Skip the POST per id. Envelope reflects what would have been called.');

  if (wiring.supportsNotifyAuthor) {
    cmd.option(
      '--notify-author',
      'Keep yourself in the notification recipients even though you triggered the change.',
    );
  }

  attachMeta(cmd, { outputSchema: wiring.schema, destructive: false });

  cmd.action(async (ids: number[] | undefined, opts: TransitionOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      validateInputSources(ids, opts);

      if (opts.stdin === true) {
        await runBatchFromStdin(opts, appConfig, env, wiring);
        return;
      }

      const resolved =
        ids !== undefined && ids.length > 0
          ? ids
          : opts.ids !== undefined
            ? parseIdsFlag(opts.ids)
            : [];

      if (resolved.length === 0) return; // silent success (batch convention)

      await runIdList(resolved, opts, appConfig, env, wiring);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

async function runIdList(
  ids: readonly number[],
  opts: TransitionOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
  wiring: VerbWiring,
): Promise<void> {
  const mode = appConfig.output.mode;
  const client = opts.dryRun === true ? null : await buildClient(appConfig, env);

  if (ids.length === 1) {
    await runOneId(ids[0]!, opts, appConfig, client, undefined, wiring);
    return;
  }

  const exitAcc = new ExitCodeAccumulator();
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i]!;
    try {
      await runOneId(id, opts, appConfig, client, undefined, wiring);
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
  opts: TransitionOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
  wiring: VerbWiring,
): Promise<void> {
  const mode = appConfig.output.mode;
  const exitAcc = new ExitCodeAccumulator();

  const allLines: string[] = [];
  for await (const line of iterateLines(process.stdin)) {
    allLines.push(line);
  }
  if (allLines.length === 0) return;

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
      await runOneId(id, opts, appConfig, client, i, wiring);
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
  opts: TransitionOpts,
  appConfig: PartialAppConfig,
  client: HttpClient | null,
  lineIndex: number | undefined,
  wiring: VerbWiring,
): Promise<void> {
  const mode = appConfig.output.mode;
  // `--notify-author` is only registered on `finish`, so this is always false
  // for `reopen`; the wire wrapper enforces the same rule independently.
  const notifyAuthor = wiring.supportsNotifyAuthor && opts.notifyAuthor === true;

  if (opts.dryRun === true) {
    const data: TaskchecksTransitionData = {
      taskcheck_id: id,
      verb: wiring.verb,
      current_state: wiring.targetState,
      notify_author: notifyAuthor,
      would: {
        method: 'POST',
        path: transitionTaskcheckPath(id, wiring.verb),
        body: notifyAuthor ? { notify_author: true } : {},
      },
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope: Envelope<TaskchecksTransitionData> = {
      schema: wiring.schema,
      data,
      dry_run: true,
    };
    if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
    writeEnvelope(envelope, mode);
    return;
  }

  if (client === null) {
    throw new ValidationError(`Internal: HTTP client missing for live ${wiring.verb}.`, {
      hintNext: 'This is a programming bug — please file an issue.',
    });
  }

  let result;
  try {
    result = await transitionTaskcheck(client, {
      taskcheckId: id,
      verb: wiring.verb,
      ...(notifyAuthor ? { notifyAuthor: true as const } : {}),
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    throw rewriteTaskcheckNotFound(err, id, wiring.smartAlternative);
  }

  const data: TaskchecksTransitionData = {
    taskcheck_id: id,
    verb: wiring.verb,
    current_state: wiring.targetState,
    notify_author: notifyAuthor,
    ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
  };
  const envelope = buildEnvelope({
    schema: wiring.schema,
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
  envelope: Envelope<TaskchecksTransitionData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    process.stdout.write(`${renderTaskchecksTransitionHuman(envelope.data)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
