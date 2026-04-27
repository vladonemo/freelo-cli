/**
 * `freelo comments list` (R16, spec 0027).
 *
 * Lists comments across all projects/tasks/docs/files/links the caller can
 * see. Maps to `GET /all-comments` (the only documented read endpoint —
 * `GET /task/{task_id}/comments` is not in `docs/api/freelo-api.yaml` and is
 * deferred per decisions/01-scope-narrow.md).
 *
 * Flags:
 *   --project <id> (repeat)         — projects_ids[]
 *   --type <enum>                   — comment-target type (default 'all')
 *   --order-by <date_add|date_edited_at>
 *   --order <asc|desc>
 *   --page <n>                      — 1-indexed, mutex with --all
 *   --all                           — iterate every page client-side
 *   --since <YYYY-MM-DD>            — client-side post-filter (mutex with --page)
 *
 * Output schema: `freelo.comments.list/v1`.
 *
 * Spec 0027 §3.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  getAllComments,
  commentMatchesSince,
  type AllCommentsFilters,
  type CommentsListResult,
} from '../../api/comments.js';
import {
  fetchAllPages,
  pagingFromNormalized,
  PartialPagesError,
  type NormalizedPage,
} from '../../api/pagination.js';
import {
  type CommentFull,
  type CommentsListAppliedFilters,
  type CommentsListData,
} from '../../api/schemas/comment.js';
import { buildEnvelope, type SchemaString, type Paging } from '../../ui/envelope.js';
import { renderAsync } from '../../ui/render.js';
import { renderCommentsListHuman } from '../../ui/human/comments-list.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.comments.list/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.comments.list/v1';

const TYPE_VALUES = ['all', 'task', 'document', 'file', 'link'] as const;
const ORDER_BY_VALUES = ['date_add', 'date_edited_at'] as const;
const ORDER_VALUES = ['asc', 'desc'] as const;

type ListOpts = {
  project?: number[];
  type?: (typeof TYPE_VALUES)[number];
  orderBy?: (typeof ORDER_BY_VALUES)[number];
  order?: (typeof ORDER_VALUES)[number];
  page?: number;
  all?: boolean;
  since?: string;
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
 * occurrence of `--project <id>`. Returns the accumulated array.
 */
function collectPositiveInt(label: string) {
  return (raw: string, prev: number[] | undefined): number[] => {
    const n = parsePositiveIntFlag(label, `${label} must be a positive integer (numeric id).`, raw);
    return prev ? [...prev, n] : [n];
  };
}

function parseEnumFlag<T extends string>(label: string, allowed: readonly T[], raw: string): T {
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ValidationError(`${label} must be one of: ${allowed.join(', ')}.`, {
      hintNext: `${label} valid values: ${allowed.join(', ')}.`,
    });
  }
  return raw as T;
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
 * `tasks list` precedent; spec 0027 decision 4).
 */
function buildAppliedFilters(opts: ListOpts): CommentsListAppliedFilters {
  const out: CommentsListAppliedFilters = {};
  if (opts.project !== undefined && opts.project.length > 0) out.projects = opts.project;
  if (opts.type !== undefined) out.type = opts.type;
  if (opts.orderBy !== undefined) out.order_by = opts.orderBy;
  if (opts.order !== undefined) out.order = opts.order;
  if (opts.since !== undefined) out.since = opts.since;
  return out;
}

/**
 * The wire filter set for `getAllComments` — strips CLI-only fields like
 * `since` (client-side) and `all` (paging mode).
 */
function filtersForAllComments(opts: ListOpts): AllCommentsFilters {
  const f: AllCommentsFilters = {};
  if (opts.project !== undefined && opts.project.length > 0) f.projects = opts.project;
  if (opts.type !== undefined) f.type = opts.type;
  if (opts.orderBy !== undefined) f.orderBy = opts.orderBy;
  if (opts.order !== undefined) f.order = opts.order;
  return f;
}

/**
 * Determine which date field `--since` filters on. Mirrors `--order-by`
 * (so the short-circuit is monotonic with respect to iteration order).
 * Defaults to `date_add` (the server default).
 */
function sinceField(opts: ListOpts): 'date_add' | 'date_edited_at' {
  return opts.orderBy ?? 'date_add';
}

/**
 * Whether `--all` short-circuit is active. True only when (a) `--since` is
 * set AND (b) effective order direction is `desc` (default; iterating from
 * newest to oldest means a single pre-cutoff item terminates the stream).
 *
 * Under `--order asc` the short-circuit is disabled — we'd be iterating
 * away from older items, so a single old item near the top doesn't tell us
 * the rest of the feed predates `since`. Spec 0027 §3.2.2 rule 3.
 */
function shouldShortCircuit(opts: ListOpts): boolean {
  if (opts.since === undefined) return false;
  // Default order is `desc` per server. Short-circuit only when desc is
  // effective (i.e. user did not pass `--order asc`).
  return opts.order !== 'asc';
}

export function registerList(
  comments: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = comments
    .command('list')
    .description(
      'List comments across all projects, tasks, documents, files and links the caller can see.',
    )
    .option(
      '--project <id>',
      'Filter to comments under this project (numeric id; repeat for OR).',
      collectPositiveInt('--project'),
    )
    .option('--type <kind>', 'Comment-target type: all, task, document, file, link.', (raw) =>
      parseEnumFlag('--type', TYPE_VALUES, raw),
    )
    .option('--order-by <field>', 'Order results by: date_add, date_edited_at.', (raw) =>
      parseEnumFlag('--order-by', ORDER_BY_VALUES, raw),
    )
    .option('--order <dir>', 'Order direction: asc or desc.', (raw) =>
      parseEnumFlag('--order', ORDER_VALUES, raw),
    )
    .option('--page <n>', '1-indexed page number to fetch (single page).', (raw) =>
      parsePositiveIntFlag('--page', '--page is a 1-indexed positive integer.', raw),
    )
    .option('--all', 'Fetch every page client-side until exhausted.')
    .option(
      '--since <date>',
      'Client-side post-filter: only comments with date >= this (YYYY-MM-DD).',
      (raw) => parseDateFlag('--since', raw),
    );
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
      if (opts.since !== undefined && opts.page !== undefined) {
        throw new ValidationError(
          '--since is client-side and cannot be combined with --page <n>.',
          {
            hintNext:
              'Combine --since with --all to iterate exhaustively, or omit --page for a default-page best-effort run.',
          },
        );
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

      const filters = filtersForAllComments(opts);
      const appliedFilters = buildAppliedFilters(opts);

      // --since cutoff (parsed once) ---------------------------------------
      const cutoffMs = opts.since !== undefined ? Date.parse(`${opts.since}T00:00:00Z`) : undefined;
      const sField = sinceField(opts);

      if (opts.all === true) {
        await runAll({
          client,
          filters,
          appliedFilters,
          cutoffMs,
          sinceField: sField,
          shortCircuit: shouldShortCircuit(opts),
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
        cutoffMs,
        sinceField: sField,
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
  filters: AllCommentsFilters;
  appliedFilters: CommentsListAppliedFilters;
  cutoffMs: number | undefined;
  sinceField: 'date_add' | 'date_edited_at';
  appConfig: PartialAppConfig;
}): Promise<void> {
  const { client, targetPage, filters, appliedFilters, cutoffMs, sinceField, appConfig } = opts;
  const mode = appConfig.output.mode;

  const result = await getAllComments(client, {
    page: targetPage,
    filters,
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });

  const filteredComments =
    cutoffMs !== undefined
      ? result.page.data.filter((c) => commentMatchesSince(c, cutoffMs, sinceField))
      : result.page.data;

  const data: CommentsListData = {
    applied_filters: appliedFilters,
    comments: filteredComments,
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
  await renderAsync(mode, envelope, (d) => renderCommentsListHuman(d));
}

/**
 * `--all` path. Iterates `?p=0, 1, …` via `fetchAllPages`. When `--since` is
 * active AND the order is `desc` (short-circuit eligible), we wrap the
 * `fetchPage` callback so that as soon as a fetched page's last item
 * predates the cutoff (in `sinceField`), we synthesize a terminal page on
 * the next iteration — which causes `fetchAllPages` to return.
 *
 * On mid-stream failure after at least one successful page, emits a partial-
 * result envelope (with `notice`) before re-throwing the underlying cause —
 * mirrors R03's `runAll` behavior so agents can resume from
 * `paging.next_cursor`.
 */
async function runAll(opts: {
  client: HttpClient;
  filters: AllCommentsFilters;
  appliedFilters: CommentsListAppliedFilters;
  cutoffMs: number | undefined;
  sinceField: 'date_add' | 'date_edited_at';
  shortCircuit: boolean;
  appConfig: PartialAppConfig;
}): Promise<void> {
  const { client, filters, appliedFilters, cutoffMs, sinceField, shortCircuit, appConfig } = opts;
  const mode = appConfig.output.mode;

  let lastResult: CommentsListResult | undefined;
  let cutoffReached = false;

  const fetchPageFn = async (p: number): Promise<NormalizedPage<CommentFull>> => {
    if (cutoffReached) {
      // Synthesize a terminal empty page; fetchAllPages will return.
      const last = lastResult;
      return {
        data: [],
        page: p,
        perPage: last?.page.perPage ?? 0,
        total: last?.page.total ?? 0,
        nextCursor: null,
      };
    }
    const r = await getAllComments(client, {
      page: p,
      filters,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    lastResult = r;

    // Short-circuit detection: if --since is active in desc-order mode AND
    // the LAST item on this page predates the cutoff, mark the cutoff so
    // the next iteration returns an empty terminal page. We still emit
    // *this* page to the accumulator (some items on it may be >= cutoff).
    if (shortCircuit && cutoffMs !== undefined && r.page.data.length > 0) {
      const lastItem = r.page.data[r.page.data.length - 1]!;
      if (!commentMatchesSince(lastItem, cutoffMs, sinceField)) {
        cutoffReached = true;
      }
    }
    return r.page;
  };

  let merged: NormalizedPage<CommentFull>;
  try {
    merged = await fetchAllPages({ fetchPage: fetchPageFn });
  } catch (err: unknown) {
    if (err instanceof PartialPagesError) {
      // `lastResult` is guaranteed defined: PartialPagesError is only thrown
      // after at least one successful page fetched.
      const partial = err.accumulated as NormalizedPage<CommentFull>;
      const filteredPartial =
        cutoffMs !== undefined
          ? partial.data.filter((c) => commentMatchesSince(c, cutoffMs, sinceField))
          : partial.data;
      const data: CommentsListData = {
        applied_filters: appliedFilters,
        comments: filteredPartial,
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
      await renderAsync(mode, envelope, (d) => renderCommentsListHuman(d));
      throw err.innerCause;
    }
    throw err;
  }

  // Apply the post-filter to the merged accumulator.
  const filteredAll =
    cutoffMs !== undefined
      ? merged.data.filter((c) => commentMatchesSince(c, cutoffMs, sinceField))
      : merged.data;

  // When --all + --since short-circuited, synthesize the paging block per
  // R03/R14 convention: page 0, per_page = filtered length, total = filtered
  // length OR observed server total (we keep the server-reported total for
  // truthfulness — see spec 0027 decision 7).
  // For the no-since --all case, mirror existing behavior: paging reflects
  // `fetchAllPages`'s merged shape.
  const synthesizedPaging: Paging =
    cutoffMs !== undefined
      ? {
          page: 0,
          per_page: filteredAll.length,
          total: merged.total,
          next_cursor: null,
        }
      : pagingFromNormalized(merged);

  const data: CommentsListData = {
    applied_filters: appliedFilters,
    comments: filteredAll,
  };
  const envelope = buildEnvelope({
    schema: SCHEMA,
    data,
    paging: synthesizedPaging,
    // `lastResult` is guaranteed defined: fetchAllPages returns only after a
    // terminating page (or throws). At least one fetch ran.
    rateLimit: {
      remaining: lastResult!.raw.rateLimit.remaining,
      reset_at: lastResult!.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  await renderAsync(mode, envelope, (d) => renderCommentsListHuman(d));
}
