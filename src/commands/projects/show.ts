import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { getProjectDetail, getProjectWorkers } from '../../api/projects.js';
import { fetchAllPages, type NormalizedPage } from '../../api/pagination.js';
import { type ProjectShowData, type UserBasic } from '../../api/schemas/project.js';
import { buildEnvelope } from '../../ui/envelope.js';
import { renderAsync } from '../../ui/render.js';
import { renderProjectsShowHuman } from '../../ui/human/projects-show.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.projects.show/v1',
  destructive: false,
};

/**
 * Allowed values for `--with` in v1. R04 ships with `workers` only; the flag
 * plumbing accepts a comma-separated list so future slices can add more
 * values (`labels`, `tasklists`, …) without breaking the contract.
 *
 * Spec 0013 §3.1 / §6.
 */
const WITH_VALUES = ['workers'] as const;
type WithValue = (typeof WITH_VALUES)[number];

type ShowOpts = {
  with?: string;
};

function parseProjectId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    // Throw ValidationError (BaseError, exitCode 2) so the top-level handler
    // recognizes it and exits 2, matching the spec contract. Commander's
    // InvalidArgumentError isn't a BaseError and would fall through to the
    // synthetic INTERNAL_ERROR (exit 1).
    throw new ValidationError('<id> must be a positive integer.', {
      hintNext: '<id> is the numeric project id from `freelo projects list`.',
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
 * Validation runs **before** any HTTP call (mirrors R03's `--fields`
 * discipline — see spec §3.5).
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
  projects: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = projects
    .command('show')
    .description("Show one project's full detail, with optional side-cars.")
    .argument('<id>', 'Project id (positive integer).', parseProjectId)
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
      const wantWorkers = withValues.includes('workers');

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

      // 1. Mandatory call — fetch project detail.
      let detail: Awaited<ReturnType<typeof getProjectDetail>>;
      try {
        detail = await getProjectDetail(client, id, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
      } catch (err: unknown) {
        throw rewriteApiHint(err, id);
      }

      // 2. Optional side-car — fetch workers (paginated, all pages).
      let workers: UserBasic[] | undefined;
      let lastWorkersRaw:
        | { rateLimit: { remaining: number | null; resetAt: string | null } }
        | undefined;
      if (wantWorkers) {
        workers = await fetchAllWorkers(client, id, appConfig, (raw) => {
          lastWorkersRaw = raw;
        });
      }

      // Build envelope. `data.workers` only present when requested.
      const data: ProjectShowData = wantWorkers
        ? { project: detail.data, workers: workers ?? [] }
        : { project: detail.data };

      const rateLimit =
        wantWorkers && lastWorkersRaw
          ? {
              remaining: lastWorkersRaw.rateLimit.remaining,
              reset_at: lastWorkersRaw.rateLimit.resetAt,
            }
          : {
              remaining: detail.rateLimit.remaining,
              reset_at: detail.rateLimit.resetAt,
            };

      const envelope = buildEnvelope({
        schema: 'freelo.projects.show/v1',
        data,
        rateLimit,
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });

      await renderAsync(mode, envelope, (d) => renderProjectsShowHuman(d));
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/**
 * Iterate `?p=0, 1, …` over `/project/{id}/workers` until exhausted, returning
 * the merged worker list. Mid-stream failures bubble as `FreeloApiError` (the
 * underlying cause is preserved by `fetchAllPages` via `PartialPagesError`,
 * but for show we discard the partial accumulator and surface the underlying
 * error directly — `show` is a single-object command, no partial envelope).
 */
async function fetchAllWorkers(
  client: HttpClient,
  projectId: number,
  appConfig: PartialAppConfig,
  onLastRaw: (raw: { rateLimit: { remaining: number | null; resetAt: string | null } }) => void,
): Promise<UserBasic[]> {
  const fetchPageFn = async (p: number): Promise<NormalizedPage<UserBasic>> => {
    const r = await getProjectWorkers(client, projectId, {
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
    // `fetchAllPages` wraps mid-stream failures in PartialPagesError carrying
    // the original cause as `innerCause`. For show we don't emit a partial
    // envelope, so unwrap and surface the original error.
    if (err instanceof Error && err.name === 'PartialPagesError') {
      const inner = (err as unknown as { innerCause: unknown }).innerCause;
      throw inner;
    }
    throw err;
  }
}

/**
 * Map a `FreeloApiError` thrown by `getProjectDetail` to a friendlier
 * `hintNext` for 404 / 403. Spec 0013 §3.5 + Decision 4.
 *
 * Returns the original error unchanged for non-FreeloApiError values and for
 * statuses other than 404 / 403.
 */
function rewriteApiHint(err: unknown, projectId: number): unknown {
  if (!(err instanceof FreeloApiError)) return err;
  if (err.httpStatus === 404) {
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: `Project ${projectId} not found, or your account does not have access.`,
    });
  }
  if (err.httpStatus === 403) {
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: `Account does not have permission to view project ${projectId}.`,
    });
  }
  return err;
}
