import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { getTaskDetail, getTaskDescription, getTaskSubtasks } from '../../api/tasks.js';
import { fetchAllPages, type NormalizedPage } from '../../api/pagination.js';
import { type TasksShowData, type Subtask } from '../../api/schemas/task.js';
import { buildEnvelope } from '../../ui/envelope.js';
import { renderAsync } from '../../ui/render.js';
import { renderTasksShowHuman } from '../../ui/human/tasks-show.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.show/v1',
  destructive: false,
};

/**
 * Allowed values for `--with` in v1 — see spec 0018 §3.1.
 *
 * The `projects` value does NOT trigger a separate HTTP call: it projects
 * the embedded `multi_project_task` block from the already-fetched
 * `TaskDetail` (decision 1, run 2026-04-27-0535-tasks-show).
 */
const WITH_VALUES = ['description', 'subtasks', 'projects'] as const;
type WithValue = (typeof WITH_VALUES)[number];

type ShowOpts = {
  with?: string;
};

/**
 * Parse the `<id>` positional. Throws `ValidationError` (BaseError, exitCode
 * 2) — NOT Commander's `InvalidArgumentError`, which falls through to the
 * synthetic INTERNAL_ERROR (exit 1). Calibration §1-2.
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

/**
 * Parse `--with a,b,c` into a deduplicated array of allowed values.
 *
 * Throws `ValidationError` (exit 2) on:
 *   - Empty string after trim (`--with ""`).
 *   - Any token not in `WITH_VALUES`.
 *
 * Validation runs **before** any HTTP call (mirrors R04 / R06 discipline).
 */
function parseWithFlag(raw: string | undefined): WithValue[] {
  if (raw === undefined) return [];
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) {
    throw new ValidationError('Specify at least one --with value, or omit --with.', {
      hintNext: 'Specify at least one --with value, or omit --with.',
    });
  }
  const allowed = new Set<string>(WITH_VALUES);
  const seen = new Set<WithValue>();
  for (const t of tokens) {
    if (!allowed.has(t)) {
      throw new ValidationError(
        `Unknown --with value '${t}'. Valid values: ${WITH_VALUES.join(', ')}.`,
        { hintNext: `--with accepts only: ${WITH_VALUES.join(', ')}.` },
      );
    }
    seen.add(t as WithValue);
  }
  return [...seen];
}

export function registerShow(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = tasks
    .command('show')
    .description("Show one task's full detail, with optional side-cars.")
    .argument('<id>', 'Task id (positive integer).', parseTaskId)
    .option(
      '--with <list>',
      `Comma-separated side-cars to include. Allowed values: ${WITH_VALUES.join(', ')}.`,
    );
  attachMeta(cmd, meta);

  cmd.action(async (id: number, opts: ShowOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // Validate --with synchronously, before any HTTP call.
      const withValues = parseWithFlag(opts.with);
      const wantDescription = withValues.includes('description');
      const wantSubtasks = withValues.includes('subtasks');
      const wantProjects = withValues.includes('projects');

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

      // 1. Mandatory call — fetch task detail.
      let detail: Awaited<ReturnType<typeof getTaskDetail>>;
      try {
        detail = await getTaskDetail(client, id, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
      } catch (err: unknown) {
        throw rewriteDetailHint(err, id);
      }

      // 2. Optional side-car — fetch the description (single object, no pagination).
      let description: Awaited<ReturnType<typeof getTaskDescription>> | undefined;
      if (wantDescription) {
        try {
          description = await getTaskDescription(client, id, {
            ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
          });
        } catch (err: unknown) {
          throw rewriteDescriptionHint(err, id);
        }
      }

      // 3. Optional side-car — fetch all subtasks pages (paginated).
      let subtasks: Subtask[] | undefined;
      let lastSubtasksRaw:
        | { rateLimit: { remaining: number | null; resetAt: string | null } }
        | undefined;
      if (wantSubtasks) {
        try {
          subtasks = await fetchAllSubtasks(client, id, appConfig, (raw) => {
            lastSubtasksRaw = raw;
          });
        } catch (err: unknown) {
          throw rewriteSubtasksHint(err, id);
        }
      }

      // 4. Optional side-car — `--with projects` projects the embedded
      //    multi_project_task block. No HTTP call (decision 1).
      //    The block can legitimately be `null` (single-project task);
      //    we preserve that distinction in the envelope.
      const projectsBlock = wantProjects ? (detail.data.multi_project_task ?? null) : undefined;

      // Build envelope. Each `data.<key>` only present when its `--with` was set.
      const data: TasksShowData = {
        task: detail.data,
        ...(wantDescription && description !== undefined ? { description: description.data } : {}),
        ...(wantSubtasks ? { subtasks: subtasks ?? [] } : {}),
        ...(wantProjects ? { projects: projectsBlock } : {}),
      };

      // Rate-limit reflects the LAST HTTP call. Order: detail → description → subtasks.
      // (`--with projects` doesn't issue a call, so it doesn't shift this.)
      let rateLimitSource: { remaining: number | null; resetAt: string | null };
      if (wantSubtasks && lastSubtasksRaw !== undefined) {
        rateLimitSource = lastSubtasksRaw.rateLimit;
      } else if (wantDescription && description !== undefined) {
        rateLimitSource = description.rateLimit;
      } else {
        rateLimitSource = detail.rateLimit;
      }

      const envelope = buildEnvelope({
        schema: 'freelo.tasks.show/v1',
        data,
        rateLimit: {
          remaining: rateLimitSource.remaining,
          reset_at: rateLimitSource.resetAt,
        },
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });

      await renderAsync(mode, envelope, (d) => renderTasksShowHuman(d));
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/**
 * Iterate `?p=0, 1, …` over `/task/{id}/subtasks` until exhausted, returning
 * the merged subtasks list. Mid-stream failures bubble as `FreeloApiError`
 * — `fetchAllPages` wraps them in `PartialPagesError` carrying the original
 * cause; for show we discard the partial accumulator and surface the
 * underlying error directly (single-object command, no partial envelope).
 *
 * Mirrors `fetchAllWorkers` in `src/commands/projects/show.ts`.
 */
async function fetchAllSubtasks(
  client: HttpClient,
  taskId: number,
  appConfig: PartialAppConfig,
  onLastRaw: (raw: { rateLimit: { remaining: number | null; resetAt: string | null } }) => void,
): Promise<Subtask[]> {
  const fetchPageFn = async (p: number): Promise<NormalizedPage<Subtask>> => {
    const r = await getTaskSubtasks(client, taskId, {
      page: p,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    onLastRaw(r.raw);
    return r.page;
  };

  try {
    const merged = await fetchAllPages({ fetchPage: fetchPageFn });
    return merged.data;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'PartialPagesError') {
      const inner = (err as unknown as { innerCause: unknown }).innerCause;
      throw inner;
    }
    throw err;
  }
}

/**
 * Re-throw a `FreeloApiError` with a fresh `hintNext` derived from the
 * resource being targeted. Centralises the "preserve every other field,
 * swap the hint" pattern shared by all three call sites.
 *
 * Returns the original error unchanged for non-FreeloApiError values and
 * for statuses other than 404 / 403 — the top-level handler renders
 * those as-is (5xx falls through unchanged, no false-positive
 * "not found" hint injection).
 */
function rewriteHint(err: unknown, hint404: string, hint403: string): unknown {
  if (!(err instanceof FreeloApiError) || (err.httpStatus !== 404 && err.httpStatus !== 403)) {
    return err;
  }
  const hintNext = err.httpStatus === 404 ? hint404 : hint403;
  return new FreeloApiError(err.message, err.code, {
    httpStatus: err.httpStatus,
    errors: err.errors,
    rawBody: err.rawBody,
    hintNext,
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
  });
}

/** Hint rewriter for `getTaskDetail` failures. Spec 0018 §3.5. */
function rewriteDetailHint(err: unknown, taskId: number): unknown {
  return rewriteHint(
    err,
    `Task ${taskId} not found, or your account does not have access.`,
    `Account does not have permission to view task ${taskId}.`,
  );
}

/** Hint rewriter for `getTaskDescription` failures. Spec 0018 §3.5. */
function rewriteDescriptionHint(err: unknown, taskId: number): unknown {
  return rewriteHint(
    err,
    `Description for task ${taskId} not found, or your account does not have access.`,
    `Account does not have permission to view description for task ${taskId}.`,
  );
}

/** Hint rewriter for `getTaskSubtasks` failures. Spec 0018 §3.5. */
function rewriteSubtasksHint(err: unknown, taskId: number): unknown {
  return rewriteHint(
    err,
    `Subtasks for task ${taskId} not found, or your account does not have access.`,
    `Account does not have permission to view subtasks for task ${taskId}.`,
  );
}
