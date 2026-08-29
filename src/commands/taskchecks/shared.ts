/**
 * Shared helpers for the `freelo taskchecks` command family (M03, spec 0066).
 *
 * The four subcommands duplicate almost nothing between them beyond input
 * parsing, client construction and the 404 rewrite — all of which are
 * genuinely identical across the family (same id space, same not-found
 * semantics), so they live here rather than being copy-pasted four times.
 *
 * The equivalents in `src/commands/files/delete.ts` and
 * `src/commands/comments/delete.ts` are per-command copies because those are
 * single-command resources; a four-command resource earns the shared module.
 */

import { type Command } from 'commander';
import { type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { BaseError } from '../../errors/base.js';

/* ---------------------------------------------------------------------------
 *  Id parsing
 *
 *  Commander parsers throw `ValidationError` (a `BaseError`, exit 2) — never
 *  Commander's `InvalidArgumentError`, which would fall through to exit 1.
 *  Calibration §1-2.
 * ------------------------------------------------------------------------- */

export const TASKCHECK_ID_HINT =
  'A taskcheck id is the `tasks_checks.id` of a *simple* checklist item — run `freelo subtasks list --task <parent-id>` and use the `id` of an item whose `type` is `taskcheck`.';

export function parseTaskcheckId(label: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`${label} must be a positive integer.`, {
      hintNext: TASKCHECK_ID_HINT,
    });
  }
  return n;
}

/** Variadic `<id>...` collector. Commander invokes this once per token. */
export function collectTaskcheckId(raw: string, prev: number[] | undefined): number[] {
  const id = parseTaskcheckId('<id>', raw);
  return prev ? [...prev, id] : [id];
}

export function parseIdsFlag(raw: string): number[] {
  const tokens = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) {
    throw new ValidationError('--ids requires at least one taskcheck id.', {
      hintNext: '--ids takes a comma- or space-separated list of taskcheck ids.',
    });
  }
  return tokens.map((t) => parseTaskcheckId('--ids', t));
}

/* ---------------------------------------------------------------------------
 *  Batch input source validation (mirrors R13 / M01 / M07)
 * ------------------------------------------------------------------------- */

export type BatchInputOpts = {
  ids?: string;
  stdin?: true;
};

export function validateInputSources(ids: number[] | undefined, opts: BatchInputOpts): void {
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
    throw new ValidationError('No taskcheck ids supplied.', {
      hintNext: `Pass ids positionally, or use --ids "1,2,3", or pipe NDJSON to --stdin. ${TASKCHECK_ID_HINT}`,
    });
  }
}

/* ---------------------------------------------------------------------------
 *  The 404 rewrite — the load-bearing part of this slice
 * ------------------------------------------------------------------------- */

/**
 * Rewrite the one failure all four taskcheck operations document: the **404**.
 *
 * It is **never** converted into a success (spec 0066 §5.1 / decision 4). R13's
 * `tasks delete` absorbs a 404 as idempotent already-deleted; this family
 * deliberately does not, and for a reason that does not apply to R13, M01 or
 * M07: the single 404 meaning the yaml documents here (:2124, :2161, :2179,
 * :2212) is *"you passed an id from the other id space"* — the item exists, is
 * untouched, and is reachable through `freelo tasks …`. Absorbing that would
 * report exit 0 while the user's checklist item sits unmodified.
 *
 * The **message stays a plain not-found**. It never asserts "you used a smart
 * id", because the CLI genuinely cannot distinguish wrong-id-space from
 * nonexistent from invisible-to-you. All three possibilities live in
 * `hint_next`, which is where a human or agent looks after the headline —
 * same message/hint discipline as `rewriteDeleteFileError`
 * (`src/commands/files/delete.ts:481`).
 *
 * `code`, `exitCode`, `retryable`, `errors`, `httpStatus` and `requestId` are
 * preserved. This is presentation, not reclassification.
 *
 * There is deliberately no 400 branch: the only documented 400 cause on these
 * endpoints is sending `priority`/`due_date`, which the CLI does not expose, so
 * the branch would be unreachable (calibration §4).
 */
export function rewriteTaskcheckNotFound(
  err: unknown,
  taskcheckId: number,
  smartAlternative: string,
): unknown {
  if (!(err instanceof FreeloApiError)) return err;
  if (err.httpStatus !== 404) return err;

  return new FreeloApiError(`Taskcheck ${taskcheckId} not found.`, err.code, {
    httpStatus: err.httpStatus,
    errors: err.errors,
    rawBody: err.rawBody,
    hintNext:
      `This endpoint only accepts a *simple* checklist item id (a \`tasks_checks.id\`). ` +
      `A smart subtask — one with its own task id — returns 404 here; use \`freelo ${smartAlternative} ${taskcheckId}\` instead. ` +
      `The id may also not exist, or not be visible to you. ` +
      `Run \`freelo subtasks list --task <parent-id>\` and check each item's \`type\` field: \`taskcheck\` = simple (use \`freelo taskchecks\`), \`subtask\` = smart (use \`freelo tasks\`).`,
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
  });
}

/* ---------------------------------------------------------------------------
 *  Misc helpers
 * ------------------------------------------------------------------------- */

export async function buildClient(
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
 * Walk the Commander tree up to the root program and read the global `--yes`
 * (`-y`) flag. It is registered on the root program, so subcommand opts do not
 * carry it. Mirrors `src/commands/files/delete.ts:217`.
 */
export function resolveYesFlag(cmd: Command): boolean {
  let cur: Command | null = cmd;
  while (cur && cur.parent) {
    cur = cur.parent;
  }
  if (cur === null) return false;
  const opts = cur.opts<{ yes?: boolean }>();
  return opts.yes === true;
}

/**
 * Coerce an unknown thrown value into a `BaseError`. Anything that is not
 * already one (defensive — a programming bug surfacing as a plain `Error`)
 * maps to `VALIDATION_ERROR` (exit 2). Mirrors R11/R13/M01/M07.
 */
export function toBaseError(err: unknown): BaseError {
  if (err instanceof BaseError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ValidationError(message, {
    hintNext: 'Investigate the underlying error and retry the id.',
  });
}

/**
 * Per-item error envelope writer for batch mode. `freelo.error/v1` augmented
 * with `context.line_index` (stdin) or `context.input_index` (positional /
 * `--ids`), plus `context.taskcheck_id` when the item parsed.
 */
export function writeBatchError(
  err: BaseError,
  index: number,
  idMaybe: number | null,
  mode: 'human' | 'json' | 'ndjson',
  fromStdin: boolean,
): void {
  if (mode === 'human') {
    const idPart = idMaybe === null ? '' : ` (${idMaybe})`;
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
  const context: Record<string, number | string> = fromStdin
    ? { line_index: index }
    : { input_index: index };
  if (idMaybe !== null) context['taskcheck_id'] = idMaybe;
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
