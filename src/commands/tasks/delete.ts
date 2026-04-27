/**
 * `freelo tasks delete <id>...` (R13, spec 0024).
 *
 * The first **destructive** command in the CLI. Ships with the shared
 * `confirmDestructive` helper (`src/lib/confirm.ts`) that every later
 * destructive command will reuse.
 *
 * Surfaces:
 *   - Single id positional: `tasks delete 9012 --yes`.
 *   - Multi positional: `tasks delete 9012 9013 9014 --yes`.
 *   - `--ids "1,2,3"` flag (mutex with positional and `--stdin`).
 *   - `--stdin` NDJSON (mutex with positional and `--ids`).
 *   - `--dry-run` (any input source) — skips the wire call AND the
 *     confirmation prompt (no destructive effect).
 *   - `--yes` — bypasses the confirmation prompt.
 *
 * Confirmation policy (spec 0024 §3.3 + §3.5):
 *   - `--yes` → unconditional proceed.
 *   - `--dry-run` → unconditional proceed (no destructive effect).
 *   - TTY without `--yes` → prompt once for the whole run (N tasks).
 *     User declines → throw `ConfirmationError` (exit 2), no wire calls.
 *   - Non-TTY without `--yes` → throw `ConfirmationError` (exit 2)
 *     immediately, no wire calls.
 *
 * Idempotency (spec 0024 §3.4 / decision 3):
 *   - DELETE returns 404 → re-classified as success-with-
 *     `already_in_target_state: true`. The task was already deleted.
 *   - No GET pre-check (decision 4): paying 2 round-trips for a destructive
 *     op is not justified by the marginal "previous_state" information.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { deleteTask, deletePath } from '../../api/tasks-delete.js';
import { type TasksDeleteData } from '../../api/schemas/task.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderTasksDeleteHuman } from '../../ui/human/tasks-delete.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import { confirmDestructive } from '../../lib/confirm.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.delete/v1',
  destructive: true,
};

const SCHEMA: SchemaString = 'freelo.tasks.delete/v1';

type DeleteOpts = {
  ids?: string;
  stdin?: true;
  dryRun?: true;
};

/* ---------------------------------------------------------------------------
 *  Per-line NDJSON schema (--stdin batch mode). Mirrors R11's BatchLineSchema —
 *  only `id` is required, no extra keys allowed.
 * ------------------------------------------------------------------------- */

const BatchLineSchema = z
  .object({
    id: z.number().int('id must be an integer (no string-form).').positive('id must be ≥ 1.'),
  })
  .strict();

/* ---------------------------------------------------------------------------
 *  Input parsing
 * ------------------------------------------------------------------------- */

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
 * Variadic `<id>...` collector. Commander invokes this once per token; bad
 * tokens surface as `ValidationError` at parse time.
 */
function collectTaskId(raw: string, prev: number[] | undefined): number[] {
  const n = parsePositiveInt('<id>', raw);
  return prev ? [...prev, n] : [n];
}

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
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerDelete(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = tasks
    .command('delete')
    .description(
      'Soft-delete one or more tasks. Destructive — requires --yes (non-TTY) or interactive confirmation (TTY). 404-after-delete is treated as idempotent already-deleted.',
    )
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
      'Skip the DELETE per id. No confirmation prompt fires. Envelope reflects what *would* have been called.',
    );
  // NOTE: `--yes` / `-y` is the **global** flag (registered on the root
  // program in `src/bin/freelo.ts:49`). Commander binds it to the root
  // program's opts, not the subcommand's. We read it via `resolveYesFlag(cmd)`
  // below — walking the command tree up to the root.
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

      const resolvedIds =
        ids !== undefined && ids.length > 0
          ? ids
          : opts.ids !== undefined
            ? parseIdsFlag(opts.ids)
            : [];

      if (resolvedIds.length === 0) {
        // No ids resolved from any source → silent success (matches R09/R11
        // batch convention; spec 0024 §5).
        return;
      }

      await runIdList(resolvedIds, opts, yes, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/**
 * Walk the Commander tree up to the root program and read the global `--yes`
 * (`-y`) flag. The flag is registered on the root program in
 * `src/bin/freelo.ts:49`; subcommand opts therefore do NOT carry it. Walking
 * up through `cmd.parent` chain returns the root, whose `opts().yes` is the
 * truth.
 *
 * Defensive: if for any reason the root cannot be reached (test harness with
 * a detached command), fall back to `false` (the safe default).
 */
function resolveYesFlag(cmd: Command): boolean {
  let cur: Command | null = cmd;
  while (cur && cur.parent) {
    cur = cur.parent;
  }
  if (cur === null) return false;
  const opts = cur.opts<{ yes?: boolean }>();
  return opts.yes === true;
}

/* ---------------------------------------------------------------------------
 *  Cross-source validation (mirrors R11)
 * ------------------------------------------------------------------------- */

function validateInputSources(ids: number[] | undefined, opts: DeleteOpts): void {
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
  if (sourceCount === 0) {
    throw new ValidationError('No task ids supplied.', {
      hintNext: 'Pass numeric ids positionally, or use --ids "a,b,c", or pipe NDJSON to --stdin.',
    });
  }
}

/* ---------------------------------------------------------------------------
 *  Batch from positional / --ids
 *
 *  Confirmation fires once for the whole run (spec 0024 §3.5 / decision 9).
 *  Single-mode error semantics mirror R11: errors bubble for one-id runs,
 *  per-id envelopes for multi-id runs.
 * ------------------------------------------------------------------------- */

async function runIdList(
  ids: readonly number[],
  opts: DeleteOpts,
  yes: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;

  // 1. Confirmation gate (once for the whole run).
  await confirmDestructive({
    promptMessage: confirmMessage(ids.length),
    yes,
    dryRun: opts.dryRun === true,
  });

  // 2. Build the client only AFTER confirmation succeeded — a non-TTY-no-yes
  //    rejection should not pay the credential-resolution cost.
  const client = await buildClient(appConfig, env);

  if (ids.length === 1) {
    // Single-id mode: errors bubble to the top-level handler so the agent
    // sees ONE envelope on stderr (matches R11/R12 single-mode contract).
    await runOneId(ids[0]!, opts, appConfig, client, /* lineIndex */ undefined);
    return;
  }

  // Multi-id mode: per-id error envelopes go to stdout (the success stream)
  // and the highest exit code wins at end-of-loop. Same shape as R11.
  const exitAcc = new ExitCodeAccumulator();
  for (let i = 0; i < ids.length; i += 1) {
    const taskId = ids[i]!;
    try {
      await runOneId(taskId, opts, appConfig, client, /* lineIndex */ undefined);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, taskId, mode, /* fromStdin */ false);
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
 *  Batch from --stdin (NDJSON)
 *
 *  Mirrors R11/R12.5 batch flow: buffer stdin → confirm once → per-line
 *  parse + run interleaved → defer-exit at end-of-loop.
 * ------------------------------------------------------------------------- */

async function runBatchFromStdin(
  opts: DeleteOpts,
  yes: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const exitAcc = new ExitCodeAccumulator();

  const stdinSource: NodeJS.ReadableStream = process.stdin;
  const allLines: string[] = [];
  for await (const line of iterateLines(stdinSource)) {
    allLines.push(line);
  }

  if (allLines.length === 0) {
    // Empty stdin → silent success exit 0 (matches R09/R11/R12.5; spec 0024 §5).
    return;
  }

  // Confirmation fires AFTER buffering (decision 7) so empty stdin never
  // prompts. We use the line count, not the count of valid rows — the user
  // is consenting to "I sent N lines, please process them"; per-line errors
  // afterwards are continue-on-error semantics, not a confirmation concern.
  await confirmDestructive({
    promptMessage: confirmMessage(allLines.length),
    yes,
    dryRun: opts.dryRun === true,
  });

  // Lazy client construction — a stdin of all-bad lines never reaches
  // credential resolution (mirrors R09/R11/R12.5).
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
      writeBatchError(result.error, i, /* taskIdMaybe */ null, mode, /* fromStdin */ true);
      exitAcc.observe(result.error.exitCode);
      continue;
    }
    const taskId = result.value.id;
    try {
      const client = await getClient();
      await runOneId(taskId, opts, appConfig, client, /* lineIndex */ i);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, taskId, mode, /* fromStdin */ true);
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
 *  Per-id flow — dry-run / DELETE / 404-idempotent
 *
 *  Spec 0024 §3.4. No pre-check GET (decision 4); the DELETE response is
 *  the source of truth.
 * ------------------------------------------------------------------------- */

async function runOneId(
  taskId: number,
  opts: DeleteOpts,
  appConfig: PartialAppConfig,
  client: HttpClient,
  lineIndex: number | undefined,
): Promise<void> {
  const mode = appConfig.output.mode;

  // ---- 1. Dry-run: skip the DELETE, emit envelope with `would`.
  if (opts.dryRun === true) {
    const data: TasksDeleteData = {
      task_id: taskId,
      previous_state: null,
      current_state: 'deleted',
      already_in_target_state: false,
      would: {
        method: 'DELETE',
        path: deletePath(taskId),
        body: {},
      },
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope: Envelope<TasksDeleteData> = {
      schema: SCHEMA,
      data,
      dry_run: true,
    };
    if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
    writeEnvelope(envelope, mode);
    return;
  }

  // ---- 2. Live DELETE.
  try {
    const result = await deleteTask(client, taskId, {
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });

    const data: TasksDeleteData = {
      task_id: taskId,
      previous_state: null,
      current_state: 'deleted',
      already_in_target_state: false,
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
    return;
  } catch (err: unknown) {
    // ---- 3. 404 → idempotent already-deleted (decision 3). Re-emit as
    //         success envelope. Calibration §4: this catch arm has dedicated
    //         test coverage (mandatory test #14, #15).
    //
    //         In multi-id / batch mode, `fromBatch === true` so the error
    //         would otherwise become a per-line envelope. We intercept BEFORE
    //         that happens because 404-on-DELETE is a SUCCESS in our policy,
    //         not an error.
    if (err instanceof FreeloApiError && err.code === 'NOT_FOUND') {
      const data: TasksDeleteData = {
        task_id: taskId,
        previous_state: null,
        current_state: 'deleted',
        already_in_target_state: true,
        ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
      };
      // No rate-limit on the 404 path is fine — the failed call still
      // populates rateLimit on the error, but FreeloApiError doesn't carry
      // it on the typed surface, and re-fetching would defeat the purpose
      // of the idempotent skip. Acceptable trade-off for v1.
      const envelope = buildEnvelope({
        schema: SCHEMA,
        data,
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      writeEnvelope(envelope, mode);
      return;
    }
    // Any other error: bubble to the caller (single-mode → top-level handler;
    // multi-id / stdin batch → per-line writer).
    throw err;
  }
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
 * Build the prompt copy for the confirmation gate. Singular vs. plural
 * matters for human readability ("delete 1 task?" reads worse than
 * "delete this task?", but agents won't see this string anyway —
 * they'd be passing `--yes`).
 */
function confirmMessage(count: number): string {
  if (count === 1) return 'Delete 1 task?';
  return `Delete ${count} tasks?`;
}

function writeEnvelope(
  envelope: Envelope<TasksDeleteData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const line = renderTasksDeleteHuman(envelope.data);
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Per-id error envelope writer for batch mode. Mirrors R11's `transition.ts`
 * shape: `freelo.error/v1` augmented with `context.line_index` (stdin) or
 * `context.input_index` (positional / --ids), plus `context.task_id` when a
 * line parsed.
 *
 * Calibration §4: this is one of the new try/catch arms; covered by tests.
 */
function writeBatchError(
  err: BaseError,
  index: number,
  taskIdMaybe: number | null,
  mode: 'human' | 'json' | 'ndjson',
  fromStdin: boolean,
): void {
  if (mode === 'human') {
    const idPart = taskIdMaybe === null ? '' : ` (task #${taskIdMaybe})`;
    process.stdout.write(`Failed item ${index + 1}${idPart}: ${err.message}\n`);
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
 * Coerce an unknown thrown value into a `BaseError`. Mirrors R11/R12. The
 * per-id catch in batch loops calls this so any throw that isn't already a
 * `BaseError` (defensive) maps to a `VALIDATION_ERROR` (exit 2) with a
 * sensible message.
 *
 * Calibration §4: this is one of the new try/catch arms; covered by tests.
 */
function toBaseError(err: unknown): BaseError {
  if (err instanceof BaseError) return err;
  // ConfirmationError is itself a BaseError subclass and would have been
  // caught above; this fallthrough handles truly unexpected throws (e.g.
  // a programming bug surfacing as a plain Error). Conservative typed
  // coercion: lossy but safe.
  const message = err instanceof Error ? err.message : String(err);
  return new ValidationError(message, {
    hintNext: 'Investigate the underlying error and retry the id.',
  });
}
