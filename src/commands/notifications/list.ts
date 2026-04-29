/**
 * `freelo notifications list` (R28, spec 0040).
 *
 * Lists notifications addressed to the calling user, with server-side filters
 * for `--unread`, `--project <id>...` (repeatable), and `--type <s>`
 * (repeatable). Pagination via `--page <n>` (1-indexed CLI → 0-indexed wire)
 * or `--all` (iterates every page).
 *
 * Maps to `GET /all-notifications`.
 *
 * v1 omits the wire's `users_ids[]`, `teams_uuids[]`, and `order` filters
 * (spec 0040 decision 04).
 *
 * Output schema: `freelo.notifications.list/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  getAllNotifications,
  type AllNotificationsFilters,
  type NotificationsListResult,
} from '../../api/notifications.js';
import {
  fetchAllPages,
  pagingFromNormalized,
  PartialPagesError,
  type NormalizedPage,
} from '../../api/pagination.js';
import {
  type Notification,
  type NotificationsListAppliedFilters,
  type NotificationsListData,
} from '../../api/schemas/notification.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { renderAsync } from '../../ui/render.js';
import { renderNotificationsListHuman } from '../../ui/human/notifications-list.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.notifications.list/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.notifications.list/v1';

type ListOpts = {
  unread?: boolean;
  project?: number[];
  type?: string[];
  page?: number;
  all?: boolean;
};

function parsePositiveIntFlag(label: string, hint: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`${label} must be a positive integer.`, { hintNext: hint });
  }
  return n;
}

function collectPositiveInt(label: string) {
  return (raw: string, prev: number[] | undefined): number[] => {
    const n = parsePositiveIntFlag(label, `${label} must be a positive integer (numeric id).`, raw);
    return prev ? [...prev, n] : [n];
  };
}

function collectString(label: string) {
  return (raw: string, prev: string[] | undefined): string[] => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new ValidationError(`${label} must be a non-empty string.`, {
        hintNext: `${label} expects a notification type string (server is the authority).`,
      });
    }
    return prev ? [...prev, trimmed] : [trimmed];
  };
}

/**
 * Build the `applied_filters` echo from the user's parsed opts. Only keys the
 * user explicitly set are emitted.
 */
function buildAppliedFilters(opts: ListOpts): NotificationsListAppliedFilters {
  const out: NotificationsListAppliedFilters = {};
  if (opts.unread === true) out.only_unread = true;
  if (opts.project !== undefined && opts.project.length > 0) out.projects = opts.project;
  if (opts.type !== undefined && opts.type.length > 0) out.types = opts.type;
  return out;
}

function filtersForWire(opts: ListOpts): AllNotificationsFilters {
  const f: AllNotificationsFilters = {};
  if (opts.unread === true) f.onlyUnread = true;
  if (opts.project !== undefined && opts.project.length > 0) f.projects = opts.project;
  if (opts.type !== undefined && opts.type.length > 0) f.types = opts.type;
  return f;
}

export function registerList(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = parent
    .command('list')
    .description(
      'List notifications addressed to the calling user (paginated). Filter by --unread / --project / --type. Server-side ACL-filtered.',
    )
    .option('--unread', 'Filter to unread notifications only (server-side `only_unread=true`).')
    .option(
      '--project <id>',
      'Filter to notifications scoped to this project (numeric id; repeat for OR).',
      collectPositiveInt('--project'),
    )
    .option(
      '--type <s>',
      'Filter to one notification type (e.g. `task_assigned`). Repeat for OR. Server is the authority on valid type strings.',
      collectString('--type'),
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
      // --- mutex check ----------------------------------------------------
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

      const filters = filtersForWire(opts);
      const appliedFilters = buildAppliedFilters(opts);

      if (opts.all === true) {
        await runAll({ client, filters, appliedFilters, appConfig });
        return;
      }

      // CLI `--page` is 1-indexed; wire is 0-indexed.
      const targetPage = opts.page !== undefined ? opts.page - 1 : 0;
      await runSinglePage({ client, targetPage, filters, appliedFilters, appConfig });
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

async function runSinglePage(opts: {
  client: HttpClient;
  targetPage: number;
  filters: AllNotificationsFilters;
  appliedFilters: NotificationsListAppliedFilters;
  appConfig: PartialAppConfig;
}): Promise<void> {
  const { client, targetPage, filters, appliedFilters, appConfig } = opts;
  const mode = appConfig.output.mode;

  const result = await getAllNotifications(client, {
    page: targetPage,
    filters,
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });

  const data: NotificationsListData = {
    applied_filters: appliedFilters,
    items: result.page.data,
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
  await renderAsync(mode, envelope, (d) => renderNotificationsListHuman(d));
}

/**
 * `--all` path. Iterates `?p=0, 1, …` via `fetchAllPages`. No client-side
 * post-filter — `--unread`, `--project`, `--type` are all server-side filters.
 *
 * On mid-stream failure after at least one successful page, emits a partial-
 * result envelope (with `notice`) before re-throwing the underlying cause —
 * mirrors `files list` runAll behavior.
 */
async function runAll(opts: {
  client: HttpClient;
  filters: AllNotificationsFilters;
  appliedFilters: NotificationsListAppliedFilters;
  appConfig: PartialAppConfig;
}): Promise<void> {
  const { client, filters, appliedFilters, appConfig } = opts;
  const mode = appConfig.output.mode;

  let lastResult: NotificationsListResult | undefined;

  const fetchPageFn = async (p: number): Promise<NormalizedPage<Notification>> => {
    const r = await getAllNotifications(client, {
      page: p,
      filters,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    lastResult = r;
    return r.page;
  };

  let merged: NormalizedPage<Notification>;
  try {
    merged = await fetchAllPages({ fetchPage: fetchPageFn });
  } catch (err: unknown) {
    if (err instanceof PartialPagesError) {
      const partial = err.accumulated as NormalizedPage<Notification>;
      const data: NotificationsListData = {
        applied_filters: appliedFilters,
        items: partial.data,
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
      await renderAsync(mode, envelope, (d) => renderNotificationsListHuman(d));
      throw err.innerCause;
    }
    throw err;
  }

  const data: NotificationsListData = {
    applied_filters: appliedFilters,
    items: merged.data,
  };
  const envelope = buildEnvelope({
    schema: SCHEMA,
    data,
    paging: pagingFromNormalized(merged),
    rateLimit: {
      remaining: lastResult!.raw.rateLimit.remaining,
      reset_at: lastResult!.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  await renderAsync(mode, envelope, (d) => renderNotificationsListHuman(d));
}
