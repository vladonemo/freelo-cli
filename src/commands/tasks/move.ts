/**
 * `freelo tasks move` (R12, spec 0022 + R12.5, spec 0023).
 *
 * Modes:
 *  - **Single** (R12): `freelo tasks move <id> --to-tasklist <id> [--to-project <id>] [--dry-run]`.
 *    One task, one destination. Envelope shape exactly as R12 v1.
 *  - **Batch** (R12.5): `freelo tasks move --stdin [--dry-run]`. NDJSON in,
 *    NDJSON out, one envelope per row. Each row: `{id, to_tasklist, to_project?}`.
 *    Continue-on-error semantics; max-of exit codes; per-row idempotency.
 *
 * Wire endpoint (both modes): `POST /task/{task_id}/move/{tasklist_id}`. The
 * destination project is server-derived from `--to-tasklist` / `to_tasklist`
 * (OpenAPI :1842-1891). `--to-project` / `to_project` is a CLI-side post-hoc
 * assertion (spec 0022 decision 2; spec 0023 decision 3 — per-row only in
 * batch).
 *
 * Per-row flow inside the batch loop is byte-identical to R12 single-id flow
 * (pre-check GET → idempotency check → POST → refresh GET → optional notice).
 * The shared body lives in `runMoveOne(...)` which accepts a pre-built client
 * and an optional `lineIndex` (undefined → single-mode envelope).
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { getTaskDetail } from '../../api/tasks.js';
import { moveTask, movePath } from '../../api/tasks-move.js';
import { type TasksMoveData, type TaskState } from '../../api/schemas/task.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderTasksMoveHuman } from '../../ui/human/tasks-move.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { BaseError } from '../../errors/base.js';
import { checkIdempotency } from '../../lib/idempotency.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.move/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.tasks.move/v1';

type MoveOpts = {
  toTasklist?: number;
  toProject?: number;
  dryRun?: true;
  stdin?: true;
};

/* ---------------------------------------------------------------------------
 *  Per-line NDJSON schema (--stdin batch mode)
 *
 *  Spec 0023 §3.2 / decision 5 — short-form keys (no `_id` suffix).
 * ------------------------------------------------------------------------- */

const BatchLineSchema = z
  .object({
    id: z.number().int('id must be an integer (no string-form).').positive('id must be ≥ 1.'),
    to_tasklist: z
      .number()
      .int('to_tasklist must be an integer.')
      .positive('to_tasklist must be ≥ 1.'),
    to_project: z
      .number()
      .int('to_project must be an integer.')
      .positive('to_project must be ≥ 1.')
      .optional(),
  })
  .strict();

/* ---------------------------------------------------------------------------
 *  Input parsing
 * ------------------------------------------------------------------------- */

/**
 * Parse the `<id>` positional. Throws `ValidationError` (BaseError, exitCode
 * 2) — NOT Commander's `InvalidArgumentError` (calibration §1-2).
 */
function parseTaskId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('<id> must be a positive integer.', {
      hintNext: '<id> is the numeric task id from `freelo tasks list`.',
    });
  }
  return n;
}

function parsePositiveIntFlag(label: string, hint: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`${label} must be a positive integer.`, { hintNext: hint });
  }
  return n;
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerMove(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = tasks
    .command('move')
    .description(
      'Move a task between tasklists (single id) or move many tasks via NDJSON --stdin batch.',
    )
    // R12.5: positional <id> is now optional so --stdin can drop it. Mutex
    // validation in the action handler enforces single-mode shape (id +
    // --to-tasklist) vs. batch-mode shape (--stdin + per-row destinations).
    .argument('[id]', 'Task id (positive integer). Required in single mode.', parseTaskId)
    .option(
      '--to-tasklist <id>',
      'Destination tasklist id (positive integer). Required in single mode; rejected with --stdin.',
      (raw) =>
        parsePositiveIntFlag(
          '--to-tasklist',
          '--to-tasklist takes the numeric tasklist id from `freelo tasklists list`.',
          raw,
        ),
    )
    .option(
      '--to-project <id>',
      'Optional project assertion (single mode only). The destination project is server-derived from --to-tasklist; this flag is a post-move sanity check (notice on mismatch). In --stdin mode, supply per-row instead.',
      (raw) =>
        parsePositiveIntFlag(
          '--to-project',
          '--to-project takes the numeric project id; it is a post-move assertion only.',
          raw,
        ),
    )
    .option(
      '--dry-run',
      'Skip the POST. Pre-check GET still runs so the envelope reflects observed state and the `would` block is exact.',
    )
    .option(
      '--stdin',
      'Batch mode: read NDJSON from stdin (one `{"id": <int>, "to_tasklist": <int>, "to_project"?: <int>}` per line). Mutex with positional <id>, --to-tasklist, and --to-project.',
    );
  attachMeta(cmd, meta);

  cmd.action(async (id: number | undefined, opts: MoveOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      validateInputSources(id, opts);

      if (opts.stdin === true) {
        await runBatchFromStdin(opts, appConfig, env);
        return;
      }

      // Single mode: id and --to-tasklist must be set (already guarded by
      // validateInputSources but this re-narrows for the type system).
      if (id === undefined) {
        throw new ValidationError('<id> is required in single mode.', {
          hintNext: 'Pass a numeric task id or switch to --stdin batch mode.',
        });
      }
      if (opts.toTasklist === undefined) {
        throw new ValidationError('--to-tasklist is required in single mode.', {
          hintNext: '--to-tasklist takes the numeric destination tasklist id.',
        });
      }

      const client = await buildClient(appConfig, env);
      await runMoveOne(
        id,
        opts.toTasklist,
        opts.toProject,
        opts.dryRun === true,
        client,
        appConfig,
        /* lineIndex */ undefined,
      );
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Cross-source validation (single vs. batch)
 * ------------------------------------------------------------------------- */

function validateInputSources(id: number | undefined, opts: MoveOpts): void {
  const hasPositional = id !== undefined;
  const hasStdin = opts.stdin === true;

  if (hasStdin && hasPositional) {
    throw new ValidationError('--stdin is mutually exclusive with positional <id>.', {
      hintNext: 'Pick exactly one: positional <id> for single mode, OR --stdin for batch.',
    });
  }
  if (hasStdin && opts.toTasklist !== undefined) {
    throw new ValidationError('--stdin is mutually exclusive with --to-tasklist.', {
      hintNext: 'In --stdin batch mode, put `to_tasklist` per row in NDJSON.',
    });
  }
  if (hasStdin && opts.toProject !== undefined) {
    throw new ValidationError('--stdin is mutually exclusive with --to-project.', {
      hintNext: 'In --stdin batch mode, put `to_project` per row (it is a per-row assertion).',
    });
  }
  if (!hasStdin && !hasPositional) {
    throw new ValidationError('<id> is required (or switch to --stdin batch mode).', {
      hintNext: 'Pass a numeric task id or use --stdin to read NDJSON rows from stdin.',
    });
  }
}

/* ---------------------------------------------------------------------------
 *  Batch mode — `--stdin` NDJSON in / NDJSON out
 *
 *  Mirrors the R11 transition.ts batch flow: lazy client construction
 *  (resolved on first valid line), in-order interleaved parse + run so stdout
 *  order matches stdin order, continue-on-error with max-of exit codes,
 *  deferred exit at end-of-loop.
 *
 *  Spec 0023 §3.4.
 * ------------------------------------------------------------------------- */

async function runBatchFromStdin(
  opts: MoveOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const exitAcc = new ExitCodeAccumulator();

  // Buffer stdin fully — line-oriented, almost always small (R09/R11 pattern).
  const stdinSource: NodeJS.ReadableStream = process.stdin;
  const allLines: string[] = [];
  for await (const line of iterateLines(stdinSource)) {
    allLines.push(line);
  }

  if (allLines.length === 0) {
    // Empty stdin → silent success exit 0 (matches R09/R11; spec 0023 §5.1).
    return;
  }

  // Build the client lazily — only when we encounter the first valid line.
  // A stdin of all-bad lines never reaches credential resolution.
  let lazyClient: HttpClient | undefined;
  const getClient = async (): Promise<HttpClient> => {
    if (lazyClient === undefined) {
      lazyClient = await buildClient(appConfig, env);
    }
    return lazyClient;
  };

  // Process lines in input order so the NDJSON output stream's order matches
  // stdin (R11 fix — spec 0021 §3.5).
  for (let i = 0; i < allLines.length; i += 1) {
    const line = allLines[i]!;
    const result = parseNdjsonLine(line, i, BatchLineSchema);
    if (!result.ok) {
      writeBatchError(result.error, i, /* taskIdMaybe */ null, mode);
      exitAcc.observe(result.error.exitCode);
      continue;
    }
    const { id: taskId, to_tasklist: toTasklistId, to_project: toProjectAssertion } = result.value;
    try {
      const client = await getClient();
      await runMoveOne(
        taskId,
        toTasklistId,
        toProjectAssertion,
        opts.dryRun === true,
        client,
        appConfig,
        /* lineIndex */ i,
      );
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, taskId, mode);
      exitAcc.observe(typed.exitCode);
    }
  }

  if (exitAcc.value !== 0) {
    // Defer-exit through the standard drain machinery (matches R09/R11).
    const { drainDispatcher, exitDeferred } = await import('../../errors/handle.js');
    await drainDispatcher();
    await exitDeferred(exitAcc.value);
  }
}

/* ---------------------------------------------------------------------------
 *  Per-id flow — pre-check, idempotency, dry-run, POST, refresh, assertion
 *
 *  Shared by single mode (lineIndex = undefined → no `line_index` in envelope)
 *  and batch mode (lineIndex = i → envelope carries `line_index: i`).
 *
 *  Spec 0022 §3.4 (the wire-level flow stays identical) +
 *  Spec 0023 §3.5 (lineIndex parameter for batch).
 * ------------------------------------------------------------------------- */

async function runMoveOne(
  taskId: number,
  toTasklistId: number,
  toProjectAssertion: number | undefined,
  dryRun: boolean,
  client: HttpClient,
  appConfig: PartialAppConfig,
  lineIndex: number | undefined,
): Promise<void> {
  const mode = appConfig.output.mode;

  // ---- 1. Pre-check via GET /task/{id}.
  const lookup = await getTaskDetail(client, taskId, {
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  const fromTasklistId = lookup.data.tasklist?.id ?? null;
  const fromProjectId = lookup.data.project?.id ?? null;
  const observedState = deriveObservedState(lookup.data.state);
  let lastRateLimit = lookup.rateLimit;

  // ---- 2. Refuse on `'deleted'` (spec 0022 decision 9).
  if (observedState === 'deleted') {
    throw new ValidationError(`Task ${taskId} is deleted; cannot move a deleted task.`, {
      hintNext: 'Deleted tasks are not addressable via move. Restore via the Freelo UI first.',
    });
  }

  // ---- 3. Idempotency check on tasklist id (pure helper, no I/O).
  // When `from_tasklist_id` is null (defensive — passthrough may let null
  // through), idempotency cannot be proven; proceed with the move and let
  // the API decide.
  const check =
    fromTasklistId === null
      ? { alreadyInTargetState: false }
      : checkIdempotency<string>({
          observedState: String(fromTasklistId),
          targetState: String(toTasklistId),
        });

  // ---- 4a. Already in target → emit envelope, NO POST, NO refresh GET.
  if (check.alreadyInTargetState) {
    const data: TasksMoveData = {
      task_id: taskId,
      from_tasklist_id: fromTasklistId,
      to_tasklist_id: toTasklistId,
      from_project_id: fromProjectId,
      to_project_id: fromProjectId,
      already_in_target_tasklist: true,
      task: lookup.data,
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope = buildSuccessEnvelope(data, lastRateLimit, appConfig);
    if (dryRun) envelope.dry_run = true;
    writeEnvelope(envelope, mode);
    return;
  }

  // ---- 4b. Dry-run: skip the POST + refresh, emit envelope with `would`.
  if (dryRun) {
    const data: TasksMoveData = {
      task_id: taskId,
      from_tasklist_id: fromTasklistId,
      to_tasklist_id: toTasklistId,
      from_project_id: fromProjectId,
      to_project_id: null,
      already_in_target_tasklist: false,
      task: lookup.data,
      would: {
        method: 'POST',
        path: movePath(taskId, toTasklistId),
        body: {},
      },
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope: Envelope<TasksMoveData> = {
      schema: SCHEMA,
      data,
      dry_run: true,
    };
    if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
    writeEnvelope(envelope, mode);
    return;
  }

  // ---- 4c. Live POST.
  const moveResult = await moveTask(client, taskId, toTasklistId, {
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  lastRateLimit = moveResult.raw.rateLimit;

  // ---- 5. Refresh GET. On failure, emit success-with-notice (spec 0022 d. 8).
  let refreshedTask: TasksMoveData['task'] = null;
  let toProjectId: number | null = null;
  let refreshNotice: string | undefined;
  try {
    const refresh = await getTaskDetail(client, taskId, {
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    refreshedTask = refresh.data;
    toProjectId = refresh.data.project?.id ?? null;
    lastRateLimit = refresh.rateLimit;
  } catch (err: unknown) {
    // Calibration §4: this catch arm has a dedicated test row.
    const detail =
      err instanceof BaseError ? err.message : err instanceof Error ? err.message : String(err);
    refreshNotice = `Move applied; post-move refresh GET failed: ${detail}. data.task is null — refetch with \`freelo tasks show ${taskId}\`.`;
  }

  // ---- 6. --to-project assertion (post-hoc; only emit notice on mismatch).
  let assertionNotice: string | undefined;
  if (
    toProjectAssertion !== undefined &&
    toProjectId !== null &&
    toProjectAssertion !== toProjectId
  ) {
    assertionNotice = `--to-project asserted ${toProjectAssertion} but post-move task is in project ${toProjectId}. Verify destination tasklist id and the project graph.`;
  }

  const data: TasksMoveData = {
    task_id: taskId,
    from_tasklist_id: fromTasklistId,
    to_tasklist_id: toTasklistId,
    from_project_id: fromProjectId,
    to_project_id: toProjectId,
    already_in_target_tasklist: false,
    task: refreshedTask,
    ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
  };
  const notices: string[] = [];
  if (refreshNotice !== undefined) notices.push(refreshNotice);
  if (assertionNotice !== undefined) notices.push(assertionNotice);
  const noticeOpt = notices.length > 0 ? notices.join(' ') : undefined;

  const envelope: Envelope<TasksMoveData> = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: lastRateLimit.remaining,
      reset_at: lastRateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    ...(noticeOpt !== undefined ? { notice: noticeOpt } : {}),
  });
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
 * Derive the observed `TaskState` from `TaskDetail.state`. Defensive: null
 * / missing block → `'active'` (most permissive default; mirrors R11
 * `transition.ts`). Unknown enum value → `'active'` for the same reason.
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
  data: TasksMoveData,
  rateLimit: { remaining: number | null; resetAt: string | null },
  appConfig: PartialAppConfig,
): Envelope<TasksMoveData> {
  return buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: rateLimit.remaining,
      reset_at: rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
}

function writeEnvelope(envelope: Envelope<TasksMoveData>, mode: 'human' | 'json' | 'ndjson'): void {
  if (mode === 'human') {
    const line = renderTasksMoveHuman(envelope.data);
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Per-line error envelope writer for batch mode. Mirrors R11
 * `transition.ts:writeBatchError` shape — `freelo.error/v1` augmented with
 * `context.line_index` and (when a line parsed) `context.task_id`.
 *
 * Calibration §4: this is one of the new try/catch arms; covered by tests.
 */
function writeBatchError(
  err: BaseError,
  lineIndex: number,
  taskIdMaybe: number | null,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    process.stdout.write(`Failed line ${lineIndex + 1}: ${err.message}\n`);
    return;
  }
  const httpStatus =
    'httpStatus' in err && typeof err.httpStatus === 'number' ? err.httpStatus : null;
  const requestId = 'requestId' in err && typeof err.requestId === 'string' ? err.requestId : null;
  const errors =
    'errors' in err && Array.isArray((err as { errors?: unknown }).errors)
      ? (err as { errors: string[] }).errors
      : undefined;
  const context: Record<string, number> = { line_index: lineIndex };
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
 * Coerce an unknown thrown value into a `BaseError`. Mirrors R09/R11. The
 * per-line catch in batch loops calls this so any throw that isn't already a
 * `BaseError` (defensive) maps to a `VALIDATION_ERROR` (exit 2) with a
 * sensible message.
 *
 * Calibration §4: this is one of the new try/catch arms; covered by tests.
 */
function toBaseError(err: unknown): BaseError {
  if (err instanceof BaseError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ValidationError(message, {
    hintNext: 'Investigate the underlying error and retry the row.',
  });
}
