/**
 * `freelo subtasks list --task <id> [--page N|--all]` (R14, spec 0025).
 *
 * Lists subtasks (taskchecks) under one parent task, paginated. Reuses the
 * existing `getTaskSubtasks` wire wrapper from R08 (`src/api/tasks.ts:208`)
 * and the `fetchAllPages` / `pagingFromNormalized` infrastructure from R03.
 *
 * Output schema: `freelo.subtasks.list/v1`.
 *
 * Spec 0025 §3.2.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { getTaskSubtasks } from '../../api/tasks.js';
import {
  fetchAllPages,
  pagingFromNormalized,
  PartialPagesError,
  type NormalizedPage,
} from '../../api/pagination.js';
import { type Subtask } from '../../api/schemas/task.js';
import { type SubtasksListData } from '../../api/schemas/subtask.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { renderAsync } from '../../ui/render.js';
import { renderSubtasksListHuman } from '../../ui/human/subtasks-list.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.subtasks.list/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.subtasks.list/v1';

type ListOpts = {
  task?: number;
  page?: number;
  all?: boolean;
};

/**
 * Parse a positive-integer flag value via Commander's parser. Throws
 * `ValidationError` (BaseError, exit 2) — NOT Commander's `InvalidArgumentError`
 * which would map to exit 1 (calibration §1-2).
 */
function parsePositiveIntFlag(label: string, hint: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`${label} must be a positive integer.`, { hintNext: hint });
  }
  return n;
}

function parseNonNegativeIntFlag(label: string, hint: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new ValidationError(`${label} must be a non-negative integer.`, { hintNext: hint });
  }
  return n;
}

export function registerList(
  subtasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = subtasks
    .command('list')
    .description('List subtasks (taskchecks) under one parent task, paginated.')
    .option('--task <id>', 'Parent task id (required, positive integer).', (raw) =>
      parsePositiveIntFlag(
        '--task',
        '--task takes the numeric parent-task id from `freelo tasks list`.',
        raw,
      ),
    )
    .option('--page <n>', '0-indexed page number (mutex with --all). Defaults to 0.', (raw) =>
      parseNonNegativeIntFlag(
        '--page',
        '--page is 0-indexed; pass 0, 1, 2, … (mutex with --all).',
        raw,
      ),
    )
    .option('--all', 'Iterate every page client-side until exhausted (mutex with --page).');
  attachMeta(cmd, meta);

  cmd.action(async (opts: ListOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // --task is required (validated here so we throw ValidationError exit 2,
      // not Commander's missing-required-option exit 1).
      if (opts.task === undefined) {
        throw new ValidationError('--task is required.', {
          hintNext: '--task takes the numeric parent-task id from `freelo tasks list`.',
        });
      }
      // Mutex: --page and --all
      if (opts.page !== undefined && opts.all === true) {
        throw new ValidationError('--page and --all are mutually exclusive.', {
          hintNext: 'Pick one: --page <n> for a single page, or --all to iterate.',
        });
      }

      const taskId = opts.task;
      const targetPage = opts.page ?? 0;

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

      if (opts.all === true) {
        await runAll(client, taskId, appConfig);
        return;
      }
      await runSinglePage(client, taskId, targetPage, appConfig);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/**
 * Single-page path. Fetches `?p=<targetPage>` and emits one envelope.
 */
async function runSinglePage(
  client: HttpClient,
  taskId: number,
  targetPage: number,
  appConfig: PartialAppConfig,
): Promise<void> {
  const mode = appConfig.output.mode;
  let result: Awaited<ReturnType<typeof getTaskSubtasks>>;
  try {
    result = await getTaskSubtasks(client, taskId, {
      page: targetPage,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    throw rewriteSubtasksHint(err, taskId);
  }

  const data: SubtasksListData = {
    task_id: taskId,
    subtasks: result.page.data,
  };
  const envelope = buildEnvelope({
    schema: SCHEMA,
    data,
    paging: pagingFromNormalized(result.page),
    rateLimit: {
      remaining: result.raw.rateLimit.remaining,
      reset_at: result.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  await renderAsync(mode, envelope, (d) => renderSubtasksListHuman(d));
}

/**
 * `--all` path. Iterates `?p=0, 1, …` via `fetchAllPages`. On mid-stream
 * failure after at least one successful page, emits a partial-result
 * envelope (with `notice`) before re-throwing the underlying cause —
 * mirrors R03's `runAll` behavior so agents can resume from
 * `paging.next_cursor`.
 */
async function runAll(
  client: HttpClient,
  taskId: number,
  appConfig: PartialAppConfig,
): Promise<void> {
  const mode = appConfig.output.mode;

  // Track the last successful response's rate-limit so the envelope reflects
  // the most recent observation (mirrors R03 / R04).
  let lastRateLimit: { remaining: number | null; resetAt: string | null } | undefined;

  const fetchPageFn = async (p: number): Promise<NormalizedPage<Subtask>> => {
    const r = await getTaskSubtasks(client, taskId, {
      page: p,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    lastRateLimit = r.raw.rateLimit;
    return r.page;
  };

  let merged: NormalizedPage<Subtask>;
  try {
    merged = await fetchAllPages({ fetchPage: fetchPageFn });
  } catch (err: unknown) {
    if (err instanceof PartialPagesError) {
      // Partial-result emit + re-throw inner cause. Mirrors R03 §5.
      // `lastRateLimit` is guaranteed defined here: PartialPagesError is only
      // thrown by `fetchAllPages` after at least one successful page was
      // fetched (which sets `lastRateLimit`). Asserted via the `!`.
      const partial = err.accumulated as NormalizedPage<Subtask>;
      const data: SubtasksListData = {
        task_id: taskId,
        subtasks: partial.data,
      };
      const envelope = buildEnvelope({
        schema: SCHEMA,
        data,
        paging: pagingFromNormalized(partial),
        rateLimit: {
          remaining: lastRateLimit!.remaining,
          reset_at: lastRateLimit!.resetAt,
        },
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        notice: `Partial result; iteration aborted at page ${err.failedPage}.`,
      });
      // For `human` mode the partial envelope still goes through the
      // table renderer; the envelope notice is preserved for `json`/`ndjson`.
      await renderAsync(mode, envelope, (d) => renderSubtasksListHuman(d));
      throw rewriteSubtasksHint(err.innerCause, taskId);
    }
    throw rewriteSubtasksHint(err, taskId);
  }

  // `lastRateLimit` is guaranteed defined here: `fetchAllPages` returns only
  // after a successful terminating page (or throws). At least one page ran.
  const data: SubtasksListData = {
    task_id: taskId,
    subtasks: merged.data,
  };
  const envelope = buildEnvelope({
    schema: SCHEMA,
    data,
    paging: pagingFromNormalized(merged),
    rateLimit: {
      remaining: lastRateLimit!.remaining,
      reset_at: lastRateLimit!.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  await renderAsync(mode, envelope, (d) => renderSubtasksListHuman(d));
}

/**
 * Hint rewriter for `getTaskSubtasks` failures. Mirrors R08's
 * `rewriteSubtasksHint`. Preserves every other field on a `FreeloApiError`
 * but swaps the `hintNext` for one that names the resource — matters when
 * the parent task is missing or the user lacks access.
 */
function rewriteSubtasksHint(err: unknown, taskId: number): unknown {
  if (!(err instanceof FreeloApiError) || (err.httpStatus !== 404 && err.httpStatus !== 403)) {
    return err;
  }
  const hintNext =
    err.httpStatus === 404
      ? `Task ${taskId} not found, or your account does not have access to its subtasks.`
      : `Account does not have permission to view subtasks for task ${taskId}.`;
  return new FreeloApiError(err.message, err.code, {
    httpStatus: err.httpStatus,
    errors: err.errors,
    rawBody: err.rawBody,
    hintNext,
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
  });
}
