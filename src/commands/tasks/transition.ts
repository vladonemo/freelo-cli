/**
 * Shared command logic for `freelo tasks finish` and `freelo tasks reopen`
 * (R11, spec 0021).
 *
 * Both commands have identical CLI surfaces (variadic `<id>...` plus `--ids`
 * plus `--stdin` plus `--dry-run`) and identical batch flow — only the verb
 * (and therefore the wire endpoint, the schema discriminant, and the target
 * state) differ. This module owns the orchestration; the leaf
 * `finish.ts` / `reopen.ts` files only pick the verb and register the
 * Commander surface.
 *
 * Spec 0021 §3.4 / §3.5.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { getTaskDetail } from '../../api/tasks.js';
import {
  finishTask,
  activateTask,
  transitionPath,
  type TransitionVerb,
} from '../../api/tasks-transition.js';
import { type TasksTransitionData, type TaskState } from '../../api/schemas/task.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import { checkIdempotency } from '../../lib/idempotency.js';
import {
  renderTasksTransitionHuman,
  renderBatchItemFailureHuman,
} from '../../ui/human/tasks-transition.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

/* ---------------------------------------------------------------------------
 *  Public types
 * ------------------------------------------------------------------------- */

export type TransitionOpts = {
  ids?: string;
  stdin?: true;
  dryRun?: true;
};

/** Per-verb wiring (schema + target state + name) — locked at register time. */
type VerbWiring = {
  verb: TransitionVerb;
  /** Verb name as used in command help / human output. */
  cliName: 'finish' | 'reopen';
  /** Schema discriminant for the success envelope. */
  schema: SchemaString;
  /** Target state on the wire (what the verb moves the task INTO). */
  targetState: TaskState;
  /** Description used in command help. */
  description: string;
};

const FINISH: VerbWiring = {
  verb: 'finish',
  cliName: 'finish',
  schema: 'freelo.tasks.finish/v1',
  targetState: 'finished',
  description: "Mark tasks as finished. Idempotent: tasks already finished aren't re-POSTed.",
};

const REOPEN: VerbWiring = {
  verb: 'reopen',
  cliName: 'reopen',
  schema: 'freelo.tasks.reopen/v1',
  targetState: 'active',
  description:
    'Reopen finished tasks (move back to active). Idempotent: already-active tasks are skipped.',
};

/* ---------------------------------------------------------------------------
 *  Input parsing
 * ------------------------------------------------------------------------- */

/**
 * Parse a positive integer from a CLI string. Throws `ValidationError` (exit
 * 2) — NOT Commander's `InvalidArgumentError` (calibration §1-2).
 */
function parsePositiveInt(label: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`${label} must be a positive integer.`, {
      hintNext: `${label} is the numeric task id from \`freelo tasks list\`.`,
    });
  }
  return n;
}

/**
 * Variadic `<id>...` collector. Each token is parsed eagerly so a bad id
 * surfaces as `ValidationError` at parse time (Commander invokes this once
 * per token).
 */
function collectTaskId(raw: string, prev: number[] | undefined): number[] {
  const n = parsePositiveInt('<id>', raw);
  return prev ? [...prev, n] : [n];
}

/**
 * Parse `--ids "a, b, c"` into a list of positive integers. Splits on commas
 * AND whitespace (so `--ids "1 2 3"` works too — agents copy-pasting from
 * editor selections appreciate this). Empty result → `ValidationError`.
 */
function parseIdsFlag(raw: string): number[] {
  const tokens = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) {
    throw new ValidationError('--ids requires at least one id.', {
      hintNext: '--ids takes a comma- or space-separated list of numeric task ids.',
    });
  }
  return tokens.map((t) => parsePositiveInt('--ids', t));
}

/* ---------------------------------------------------------------------------
 *  Per-line NDJSON schema (--stdin batch mode)
 * ------------------------------------------------------------------------- */

const BatchLineSchema = z
  .object({
    id: z.number().int('id must be an integer (no string-form).').positive('id must be ≥ 1.'),
  })
  .strict();

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

/** Register `tasks finish`. Wired via `src/commands/tasks.ts`. */
export function registerFinish(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  registerTransition(tasks, getConfig, env, FINISH);
}

/** Register `tasks reopen`. Wired via `src/commands/tasks.ts`. */
export function registerReopen(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  registerTransition(tasks, getConfig, env, REOPEN);
}

function registerTransition(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
  wiring: VerbWiring,
): void {
  const meta: CommandMeta = {
    outputSchema: wiring.schema,
    destructive: false,
  };

  const cmd = tasks
    .command(wiring.cliName)
    .description(wiring.description)
    .argument('[id...]', 'One or more numeric task ids (positional).', collectTaskId)
    .option(
      '--ids <list>',
      'Comma- or space-separated list of task ids (mutex with positional <id> and --stdin).',
    )
    .option(
      '--stdin',
      'Read NDJSON from stdin (one `{"id": <int>}` per line). Mutex with positional and --ids.',
    )
    .option(
      '--dry-run',
      'Skip the POST per id. Pre-check GET still runs so the envelope reflects observed state.',
    );
  attachMeta(cmd, meta);

  cmd.action(async (ids: number[] | undefined, opts: TransitionOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // Resolve the source of truth for ids before any HTTP. Validation here
      // runs in a single pass — agents get one error envelope on bad input.
      validateInputSources(ids, opts);

      if (opts.stdin === true) {
        await runBatchFromStdin(opts, appConfig, env, wiring);
        return;
      }

      // Positional `[id...]` OR `--ids` resolves to a number[] up front.
      const resolvedIds =
        ids !== undefined && ids.length > 0
          ? ids
          : opts.ids !== undefined
            ? parseIdsFlag(opts.ids)
            : [];

      if (resolvedIds.length === 0) {
        // No ids resolved from any source → silent success exit 0
        // (matches R09 batch convention; spec 0021 decision 5).
        return;
      }
      await runIdList(resolvedIds, opts, appConfig, env, wiring, /* fromStdin */ false);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Cross-source validation
 * ------------------------------------------------------------------------- */

function validateInputSources(ids: number[] | undefined, opts: TransitionOpts): void {
  const hasPositional = ids !== undefined && ids.length > 0;
  const hasIdsFlag = opts.ids !== undefined && opts.ids.trim().length > 0;
  const hasStdin = opts.stdin === true;
  const sourceCount = (hasPositional ? 1 : 0) + (hasIdsFlag ? 1 : 0) + (hasStdin ? 1 : 0);
  if (sourceCount > 1) {
    throw new ValidationError(
      'Pick exactly one input source: positional <id>..., --ids, or --stdin.',
      {
        hintNext: 'Combining input sources is ambiguous — agents should pre-resolve to one shape.',
      },
    );
  }
}

/* ---------------------------------------------------------------------------
 *  Batch from --stdin (NDJSON)
 * ------------------------------------------------------------------------- */

async function runBatchFromStdin(
  opts: TransitionOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
  wiring: VerbWiring,
): Promise<void> {
  const mode = appConfig.output.mode;
  const exitAcc = new ExitCodeAccumulator();

  // Buffer stdin fully (matches R09 batch — line-oriented, almost always
  // small; chunk-streaming is a follow-up if huge inputs ever land).
  const stdinSource: NodeJS.ReadableStream = process.stdin;
  const allLines: string[] = [];
  for await (const line of iterateLines(stdinSource)) {
    allLines.push(line);
  }

  if (allLines.length === 0) {
    // Empty stdin → silent success (decision 5).
    return;
  }

  // Build the client lazily — only when we encounter the first valid line.
  // Mirrors R09's startup-time discipline: a stdin of all-bad lines never
  // reaches credential resolution. (For the transition verbs we still build
  // the client for any valid line; the `lazyClient` cache avoids re-building
  // on every iteration.)
  let lazyClient: HttpClient | undefined;
  const getClient = async (): Promise<HttpClient> => {
    if (lazyClient === undefined) {
      lazyClient = await buildClient(appConfig, env);
    }
    return lazyClient;
  };

  // Process lines in input order so the NDJSON output stream's order matches
  // stdin. (An earlier draft parsed all lines up front then ran the valid
  // ones in a second loop — that reordered stdout, putting parse errors
  // before successes regardless of input position. Fix: interleave parse
  // and run.)
  for (let i = 0; i < allLines.length; i += 1) {
    const line = allLines[i]!;
    const result = parseNdjsonLine(line, i, BatchLineSchema);
    if (!result.ok) {
      writeBatchError(result.error, i, /* taskIdMaybe */ null, mode, /* fromStdin */ true);
      exitAcc.observe(result.error.exitCode);
      continue;
    }
    const taskId = result.value.id;
    try {
      const client = await getClient();
      await runOneId(taskId, opts, appConfig, wiring, client, i, /* fromStdin */ true);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, taskId, mode, /* fromStdin */ true);
      exitAcc.observe(typed.exitCode);
    }
  }

  if (exitAcc.value !== 0) {
    // Defer-exit through the standard drain machinery (matches R09).
    const { drainDispatcher, exitDeferred } = await import('../../errors/handle.js');
    await drainDispatcher();
    await exitDeferred(exitAcc.value);
  }
}

/* ---------------------------------------------------------------------------
 *  Batch from positional / --ids
 * ------------------------------------------------------------------------- */

async function runIdList(
  ids: readonly number[],
  opts: TransitionOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
  wiring: VerbWiring,
  fromStdin: boolean,
): Promise<void> {
  const mode = appConfig.output.mode;
  const client = await buildClient(appConfig, env);

  // Single-id mode (one positional id, no --ids list): errors bubble up to
  // the top-level handler (which writes a `freelo.error/v1` envelope to
  // stderr and sets the exit code). This matches R09/R10 single-mode shape:
  // an agent invoking `freelo tasks finish 9012` gets ONE envelope on stdout
  // (success) OR ONE envelope on stderr (failure), never a per-id stream.
  //
  // Multi-id mode (positional 9012 9013 9014 OR --ids a,b,c): per-id error
  // envelopes go to stdout (the success path's stream) and the highest exit
  // code wins at end-of-loop. Same shape as R09 batch.
  if (ids.length === 1) {
    await runOneId(ids[0]!, opts, appConfig, wiring, client, undefined, fromStdin);
    return;
  }

  const exitAcc = new ExitCodeAccumulator();
  for (let i = 0; i < ids.length; i += 1) {
    const taskId = ids[i]!;
    try {
      // For non-stdin sources we don't carry a `line_index` in the envelope
      // (decision 10), so pass `undefined`.
      await runOneId(taskId, opts, appConfig, wiring, client, undefined, fromStdin);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, taskId, mode, fromStdin);
      exitAcc.observe(typed.exitCode);
    }
  }

  if (exitAcc.value !== 0) {
    const { drainDispatcher, exitDeferred } = await import('../../errors/handle.js');
    await drainDispatcher();
    await exitDeferred(exitAcc.value);
  }
}

/* ---------------------------------------------------------------------------
 *  Per-id flow (single id — pre-check, idempotency, POST or skip)
 * ------------------------------------------------------------------------- */

async function runOneId(
  taskId: number,
  opts: TransitionOpts,
  appConfig: PartialAppConfig,
  wiring: VerbWiring,
  client: HttpClient,
  lineIndex: number | undefined,
  fromStdin: boolean,
): Promise<void> {
  const mode = appConfig.output.mode;

  // ---- 1. Pre-check via GET /task/{id}.
  const lookup = await getTaskDetail(client, taskId, {
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  const observed = deriveObservedState(lookup.data.state);
  let lastRateLimit = lookup.rateLimit;

  // ---- 2. Refuse on `'deleted'` for either verb (decision 14).
  if (observed === 'deleted') {
    throw new ValidationError(
      `Task ${taskId} is deleted; cannot ${wiring.cliName} a deleted task.`,
      {
        hintNext:
          'Deleted tasks are not addressable via finish/reopen. Restore via the Freelo UI first.',
      },
    );
  }

  // ---- 3. Idempotency check — pure helper, no I/O.
  const check = checkIdempotency<TaskState>({
    observedState: observed,
    targetState: wiring.targetState,
  });

  // ---- 4a. Already in target → emit success envelope, NO POST.
  if (check.alreadyInTargetState) {
    const data: TasksTransitionData = {
      task_id: taskId,
      previous_state: observed,
      current_state: observed,
      already_in_target_state: true,
      verb: wiring.verb,
      ...(fromStdin && lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope = buildSuccessEnvelope(wiring, data, lastRateLimit, appConfig);
    writeEnvelope(envelope, mode);
    return;
  }

  // ---- 4b. Dry-run: skip the POST, emit envelope with `would`.
  if (opts.dryRun === true) {
    const data: TasksTransitionData = {
      task_id: taskId,
      previous_state: observed,
      current_state: observed, // No transition happened.
      already_in_target_state: false,
      verb: wiring.verb,
      would: {
        method: 'POST',
        path: transitionPath(wiring.verb, taskId),
        body: {},
      },
      ...(fromStdin && lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope: Envelope<TasksTransitionData> = {
      schema: wiring.schema,
      data,
      dry_run: true,
    };
    if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
    writeEnvelope(envelope, mode);
    return;
  }

  // ---- 4c. Live POST.
  const result =
    wiring.verb === 'finish'
      ? await finishTask(client, taskId, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        })
      : await activateTask(client, taskId, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
  lastRateLimit = result.raw.rateLimit;

  // ---- 5. Build success envelope. `current_state` = target (the POST 200'd).
  const data: TasksTransitionData = {
    task_id: taskId,
    previous_state: observed,
    current_state: wiring.targetState,
    already_in_target_state: false,
    verb: wiring.verb,
    ...(fromStdin && lineIndex !== undefined ? { line_index: lineIndex } : {}),
  };
  const envelope = buildSuccessEnvelope(wiring, data, lastRateLimit, appConfig);
  writeEnvelope(envelope, mode);
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

/**
 * Derive the observed `TaskState` from `TaskDetail.state`. Defensive:
 *   - `null` / missing block → `'active'` (most permissive default; spec
 *     0021 decision 15). The CLI does NOT emit a notice for this case in v1
 *     — it would confuse agents that rely on `notice` for warnings; if the
 *     defaulting becomes a real-world surprise, R12+ can add a notice path.
 *   - Unknown enum value → `'active'` (same defaulting; passthrough() on the
 *     wire schema may let unknown future states through).
 *   - Known enum → narrow.
 */
function deriveObservedState(state: { state?: string | null } | null | undefined): TaskState {
  const raw = state?.state;
  if (
    raw === 'active' ||
    raw === 'archived' ||
    raw === 'finished' ||
    raw === 'deleted' ||
    raw === 'template'
  ) {
    return raw;
  }
  return 'active';
}

function buildSuccessEnvelope(
  wiring: VerbWiring,
  data: TasksTransitionData,
  rateLimit: { remaining: number | null; resetAt: string | null },
  appConfig: PartialAppConfig,
): Envelope<TasksTransitionData> {
  return buildEnvelope({
    schema: wiring.schema,
    data,
    rateLimit: {
      remaining: rateLimit.remaining,
      reset_at: rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
}

function writeEnvelope(
  envelope: Envelope<TasksTransitionData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const line = renderTasksTransitionHuman(envelope.data);
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Per-id error envelope writer for batch mode. Mirrors R09's `writeBatchError`
 * but adapts the context shape: `--stdin` carries `line_index`, positional /
 * `--ids` carry `input_index` (decision 11).
 */
function writeBatchError(
  err: BaseError,
  index: number,
  taskIdMaybe: number | null,
  mode: 'human' | 'json' | 'ndjson',
  fromStdin: boolean,
): void {
  if (mode === 'human') {
    process.stdout.write(`${renderBatchItemFailureHuman(index, taskIdMaybe, err.message)}\n`);
    return;
  }
  const httpStatus =
    'httpStatus' in err && typeof err.httpStatus === 'number' ? err.httpStatus : null;
  const requestId = 'requestId' in err && typeof err.requestId === 'string' ? err.requestId : null;
  const errors =
    'errors' in err && Array.isArray((err as { errors?: unknown }).errors)
      ? (err as { errors: string[] }).errors
      : undefined;
  const context: Record<string, number> = fromStdin
    ? { line_index: index }
    : { input_index: index };
  if (taskIdMaybe !== null) context['task_id'] = taskIdMaybe;
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
      context,
    },
  };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Coerce an unknown thrown value into a `BaseError`. Mirrors R09's
 * `toBaseError` — the per-id catch in batch loops calls this so any throw
 * that isn't already a `BaseError` (defensive: should not happen in normal
 * flow) maps to a `VALIDATION_ERROR` (exit 2) with a sensible message.
 *
 * Calibration §4: this is one of the new try/catch arms; covered by tests.
 */
function toBaseError(err: unknown): BaseError {
  if (err instanceof BaseError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ValidationError(message, {
    hintNext: 'Investigate the underlying error and retry the id.',
  });
}
