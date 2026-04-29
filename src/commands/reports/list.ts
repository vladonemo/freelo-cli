/**
 * `freelo reports list` (R21, spec 0033).
 *
 * Lists work reports (finalized time entries) the caller can see, with
 * filters by project, worker, task, and a `date_reported` window. Maps to
 * `GET /work-reports` (the only documented list endpoint —
 * `GET /task/{task_id}/work-reports` is not in `docs/api/freelo-api.yaml`
 * and is deferred per
 * `docs/decisions/2026-04-28-2111-r21-reports-list-1-scope-narrow.md`).
 *
 * Flags:
 *   --task <id>    (repeat) — tasks_ids[]
 *   --project <id> (repeat) — projects_ids[]
 *   --worker <id>  (repeat) — users_ids[]
 *   --from <YYYY-MM-DD>     — date_reported_range[date_from]
 *   --to   <YYYY-MM-DD>     — date_reported_range[date_to]
 *   --page <n>              — 1-indexed CLI → 0-indexed wire; mutex with --all
 *   --all                   — iterate every page client-side
 *
 * Output schema: `freelo.reports.list/v1`.
 *
 * Spec 0033 §3.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  getWorkReports,
  type WorkReportsFilters,
  type ReportsListResult,
} from '../../api/reports.js';
import {
  fetchAllPages,
  pagingFromNormalized,
  PartialPagesError,
  type NormalizedPage,
} from '../../api/pagination.js';
import {
  type WorkReportFull,
  type ReportsListAppliedFilters,
  type ReportsListData,
} from '../../api/schemas/report.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { renderAsync } from '../../ui/render.js';
import { renderReportsListHuman } from '../../ui/human/reports-list.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.reports.list/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.reports.list/v1';

type ListOpts = {
  task?: number[];
  project?: number[];
  worker?: number[];
  from?: string;
  to?: string;
  page?: number;
  all?: boolean;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a positive-integer flag value. Throws `ValidationError` (BaseError,
 * exit 2) — NOT Commander's `InvalidArgumentError` which would map to exit 1
 * (Calibration §1-2).
 */
function parsePositiveIntFlag(label: string, hint: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`${label} must be a positive integer.`, { hintNext: hint });
  }
  return n;
}

/**
 * Variadic positive-int collector — Commander invokes the parser once per
 * occurrence of `--task <id>` (or `--project` / `--worker`). Returns the
 * accumulated array. Pattern matches `comments list --project`.
 */
function collectPositiveInt(label: string) {
  return (raw: string, prev: number[] | undefined): number[] => {
    const n = parsePositiveIntFlag(label, `${label} must be a positive integer (numeric id).`, raw);
    return prev ? [...prev, n] : [n];
  };
}

function parseDateFlag(label: string, raw: string): string {
  if (!ISO_DATE.test(raw)) {
    throw new ValidationError(`${label} must be in YYYY-MM-DD format.`, {
      hintNext: 'Use ISO date format, e.g. 2026-04-01.',
    });
  }
  const t = Date.parse(`${raw}T00:00:00Z`);
  if (Number.isNaN(t)) {
    throw new ValidationError(`${label} is not a valid date.`, {
      hintNext: 'Use a real calendar date in YYYY-MM-DD format.',
    });
  }
  return raw;
}

/**
 * Build the `applied_filters` echo from the user's parsed opts. Only keys
 * the user explicitly set are emitted — unset keys are omitted (mirrors
 * `comments list` precedent; spec 0033 §3.3).
 */
function buildAppliedFilters(opts: ListOpts): ReportsListAppliedFilters {
  const out: ReportsListAppliedFilters = {};
  if (opts.task !== undefined && opts.task.length > 0) out.tasks = opts.task;
  if (opts.project !== undefined && opts.project.length > 0) out.projects = opts.project;
  if (opts.worker !== undefined && opts.worker.length > 0) out.workers = opts.worker;
  if (opts.from !== undefined) out.from = opts.from;
  if (opts.to !== undefined) out.to = opts.to;
  return out;
}

/**
 * The wire filter set for `getWorkReports` — strips CLI-only fields like
 * `all` (paging mode). Direct mapping: every CLI flag has a wire counterpart.
 */
function filtersForWorkReports(opts: ListOpts): WorkReportsFilters {
  const f: WorkReportsFilters = {};
  if (opts.task !== undefined && opts.task.length > 0) f.tasks = opts.task;
  if (opts.project !== undefined && opts.project.length > 0) f.projects = opts.project;
  if (opts.worker !== undefined && opts.worker.length > 0) f.workers = opts.worker;
  if (opts.from !== undefined) f.from = opts.from;
  if (opts.to !== undefined) f.to = opts.to;
  return f;
}

export function registerList(
  reports: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = reports
    .command('list')
    .description(
      'List work reports (time entries) across all projects, with optional task / project / worker / date filters.',
    )
    .option(
      '--task <id>',
      'Filter to reports on this task (numeric id; repeat for OR).',
      collectPositiveInt('--task'),
    )
    .option(
      '--project <id>',
      'Filter to reports under this project (numeric id; repeat for OR).',
      collectPositiveInt('--project'),
    )
    .option(
      '--worker <id>',
      'Filter to reports logged by this worker (numeric id; repeat for OR).',
      collectPositiveInt('--worker'),
    )
    .option('--from <date>', 'Lower bound on date_reported (YYYY-MM-DD, inclusive).', (raw) =>
      parseDateFlag('--from', raw),
    )
    .option('--to <date>', 'Upper bound on date_reported (YYYY-MM-DD, inclusive).', (raw) =>
      parseDateFlag('--to', raw),
    )
    .option('--page <n>', '1-indexed page number to fetch (single page).', (raw) =>
      parsePositiveIntFlag('--page', '--page is a 1-indexed positive integer.', raw),
    )
    .option('--all', 'Fetch every page client-side until exhausted.');
  attachMeta(cmd, meta);

  cmd.action(async (opts: ListOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // --- mutex checks ---------------------------------------------------
      if (opts.page !== undefined && opts.all === true) {
        throw new ValidationError('--page and --all are mutually exclusive.', {
          hintNext: 'Pick one: --page <n> for a single page, or --all to iterate.',
        });
      }

      // --- credentials + client -------------------------------------------
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

      const filters = filtersForWorkReports(opts);
      const appliedFilters = buildAppliedFilters(opts);

      if (opts.all === true) {
        await runAll({
          client,
          filters,
          appliedFilters,
          appConfig,
        });
        return;
      }

      // Default and `--page N` paths share single-page logic.
      // CLI `--page` is 1-indexed; wire is 0-indexed.
      const targetPage = opts.page !== undefined ? opts.page - 1 : 0;
      await runSinglePage({
        client,
        targetPage,
        filters,
        appliedFilters,
        appConfig,
      });
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

async function runSinglePage(opts: {
  client: HttpClient;
  targetPage: number;
  filters: WorkReportsFilters;
  appliedFilters: ReportsListAppliedFilters;
  appConfig: PartialAppConfig;
}): Promise<void> {
  const { client, targetPage, filters, appliedFilters, appConfig } = opts;
  const mode = appConfig.output.mode;

  const result = await getWorkReports(client, {
    page: targetPage,
    filters,
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });

  const data: ReportsListData = {
    applied_filters: appliedFilters,
    reports: result.page.data,
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
  await renderAsync(mode, envelope, (d) => renderReportsListHuman(d));
}

/**
 * `--all` path. Iterates `?p=0, 1, …` via `fetchAllPages`. No client-side
 * post-filter (unlike R16 `comments list --since`) — `--from` / `--to` are
 * server-side filters via `date_reported_range`, so iteration just merges
 * pages.
 *
 * On mid-stream failure after at least one successful page, emits a partial-
 * result envelope (with `notice`) before re-throwing the underlying cause —
 * mirrors R03 / R16 `runAll` behavior so agents can resume from
 * `paging.next_cursor`.
 */
async function runAll(opts: {
  client: HttpClient;
  filters: WorkReportsFilters;
  appliedFilters: ReportsListAppliedFilters;
  appConfig: PartialAppConfig;
}): Promise<void> {
  const { client, filters, appliedFilters, appConfig } = opts;
  const mode = appConfig.output.mode;

  let lastResult: ReportsListResult | undefined;

  const fetchPageFn = async (p: number): Promise<NormalizedPage<WorkReportFull>> => {
    const r = await getWorkReports(client, {
      page: p,
      filters,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    lastResult = r;
    return r.page;
  };

  let merged: NormalizedPage<WorkReportFull>;
  try {
    merged = await fetchAllPages({ fetchPage: fetchPageFn });
  } catch (err: unknown) {
    if (err instanceof PartialPagesError) {
      // `lastResult` is guaranteed defined: PartialPagesError is only thrown
      // after at least one successful page fetched.
      const partial = err.accumulated as NormalizedPage<WorkReportFull>;
      const data: ReportsListData = {
        applied_filters: appliedFilters,
        reports: partial.data,
      };
      const envelope = buildEnvelope({
        schema: SCHEMA,
        data,
        paging: pagingFromNormalized(partial),
        rateLimit: {
          remaining: lastResult!.raw.rateLimit.remaining,
          reset_at: lastResult!.raw.rateLimit.resetAt,
        },
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        notice: `Partial result; iteration aborted at page ${err.failedPage}.`,
      });
      await renderAsync(mode, envelope, (d) => renderReportsListHuman(d));
      throw err.innerCause;
    }
    throw err;
  }

  const data: ReportsListData = {
    applied_filters: appliedFilters,
    reports: merged.data,
  };
  const envelope = buildEnvelope({
    schema: SCHEMA,
    data,
    paging: pagingFromNormalized(merged),
    // `lastResult` is guaranteed defined: fetchAllPages returns only after a
    // terminating page (or throws). At least one fetch ran.
    rateLimit: {
      remaining: lastResult!.raw.rateLimit.remaining,
      reset_at: lastResult!.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  await renderAsync(mode, envelope, (d) => renderReportsListHuman(d));
}
