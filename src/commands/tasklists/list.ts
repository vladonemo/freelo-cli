import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { getAllTasklists, type TasklistsListResult } from '../../api/tasklists.js';
import {
  fetchAllPages,
  pagingFromNormalized,
  PartialPagesError,
  projectFields,
  type NormalizedPage,
} from '../../api/pagination.js';
import {
  TASKLIST_DEFAULT_FIELDS,
  type TasklistFull,
  type TasklistListData,
} from '../../api/schemas/tasklist.js';
import { buildEnvelope } from '../../ui/envelope.js';
import { renderAsync } from '../../ui/render.js';
import { renderTasklistsListHuman } from '../../ui/human/tasklists-list.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';
import { parseFieldsFlag } from '../../lib/parse-fields.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasklists.list/v1',
  destructive: false,
};

type ListOpts = {
  project?: number;
  page?: number;
  all?: boolean;
  cursor?: number;
  fields?: string;
};

/**
 * Parse a positive-integer flag. Throws `ValidationError` (BaseError, exit 2)
 * — NOT Commander's `InvalidArgumentError`, which falls through to exit 1
 * (Calibration §1-2). Used for both `--project <id>` and `--page <n>`.
 */
function parsePositiveIntFlag(label: string, hint: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`${label} must be a positive integer.`, { hintNext: hint });
  }
  return n;
}

/**
 * Parse a non-negative-integer flag (for `--cursor`). Throws `ValidationError`
 * (exit 2) on bad input.
 */
function parseNonNegativeIntFlag(label: string, hint: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new ValidationError(`${label} must be a non-negative integer.`, { hintNext: hint });
  }
  return n;
}

export function registerList(
  tasklists: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = tasklists
    .command('list')
    .description(
      'List tasklists across all projects you can see, optionally filtered to one project.',
    )
    .option(
      '--project <id>',
      'Filter to tasklists in this project (numeric id from `freelo projects list`).',
      (raw) =>
        parsePositiveIntFlag(
          '--project',
          '--project is the numeric project id from `freelo projects list`.',
          raw,
        ),
    )
    .option('--page <n>', '1-indexed page number to fetch (single page).', (raw) =>
      parsePositiveIntFlag('--page', '--page is a 1-indexed positive integer.', raw),
    )
    .option('--all', 'Fetch every page client-side until exhausted.')
    .option(
      '--cursor <n>',
      'Resume at the cursor value reported by a prior envelope (0-indexed).',
      (raw) =>
        parseNonNegativeIntFlag('--cursor', '--cursor is a 0-indexed non-negative integer.', raw),
    )
    .option(
      '--fields <list>',
      'Comma-separated list of top-level fields to include in each record.',
    );
  attachMeta(cmd, meta);

  cmd.action(async (opts: ListOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // Mutual-exclusion check (spec §2.1).
      const flags: string[] = [];
      if (opts.page !== undefined) flags.push('--page');
      if (opts.all === true) flags.push('--all');
      if (opts.cursor !== undefined) flags.push('--cursor');
      if (flags.length > 1) {
        throw new ValidationError('Flags --page, --all, and --cursor are mutually exclusive.', {
          hintNext: 'Pick one of --page, --all, or --cursor.',
        });
      }

      const requested = parseFieldsFlag(opts.fields);

      // Validate --fields BEFORE any HTTP call (spec §2.5).
      if (requested !== undefined) {
        projectFields(
          [] as Record<string, unknown>[],
          requested,
          TASKLIST_DEFAULT_FIELDS,
          'tasklist',
        );
      }

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

      const targetPage = computeTargetPage(opts);
      const scope: 'project' | 'all' = opts.project !== undefined ? 'project' : 'all';
      const projectId: number | null = opts.project ?? null;

      // --all path: iterate.
      if (opts.all === true) {
        await runAll({
          client,
          scope,
          projectId,
          requested,
          mode,
          appConfig,
        });
        return;
      }

      // Single-page path (default, --page, or --cursor).
      const result = await fetchPage(client, projectId, targetPage, appConfig);
      const data = buildEnvelopeData(scope, projectId, result.page.data, requested);
      const envelope = buildEnvelope({
        schema: 'freelo.tasklists.list/v1',
        data,
        paging: pagingFromNormalized(result.page),
        rateLimit: {
          remaining: result.raw.rateLimit.remaining,
          reset_at: result.raw.rateLimit.resetAt,
        },
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      await renderAsync(mode, envelope, (d) =>
        renderTasklistsListHuman(d, requested ? { displayFields: requested } : {}),
      );
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

function computeTargetPage(opts: ListOpts): number {
  if (opts.page !== undefined) return opts.page - 1; // 1-indexed → 0-indexed wire
  if (opts.cursor !== undefined) return opts.cursor;
  return 0;
}

async function fetchPage(
  client: HttpClient,
  projectId: number | null,
  page: number,
  appConfig: PartialAppConfig,
): Promise<TasklistsListResult<TasklistFull>> {
  return getAllTasklists(client, {
    page,
    ...(projectId !== null ? { projectId } : {}),
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
}

function buildEnvelopeData(
  scope: 'project' | 'all',
  projectId: number | null,
  records: ReadonlyArray<Record<string, unknown>>,
  requested: string[] | undefined,
): TasklistListData {
  const projected =
    requested !== undefined && requested.length > 0
      ? projectFields(records, requested, TASKLIST_DEFAULT_FIELDS, 'tasklist')
      : records;
  return {
    scope,
    project_id: projectId,
    // Projection narrows but keeps shape compatible.
    tasklists: projected as TasklistListData['tasklists'],
  };
}

async function runAll(opts: {
  client: HttpClient;
  scope: 'project' | 'all';
  projectId: number | null;
  requested: string[] | undefined;
  mode: 'human' | 'json' | 'ndjson';
  appConfig: PartialAppConfig;
}): Promise<void> {
  const { client, scope, projectId, requested, mode, appConfig } = opts;

  let lastRaw: TasklistsListResult<TasklistFull> | undefined;

  const fetchPageFn = async (p: number): Promise<NormalizedPage<TasklistFull>> => {
    const r = await fetchPage(client, projectId, p, appConfig);
    lastRaw = r;
    return r.page;
  };

  const onPage =
    mode === 'ndjson'
      ? (page: NormalizedPage<TasklistFull>): void => {
          const data = buildEnvelopeData(
            scope,
            projectId,
            page.data as ReadonlyArray<Record<string, unknown>>,
            requested,
          );
          const envelope = buildEnvelope({
            schema: 'freelo.tasklists.list/v1',
            data,
            paging: pagingFromNormalized(page),
            ...(lastRaw !== undefined
              ? {
                  rateLimit: {
                    remaining: lastRaw.raw.rateLimit.remaining,
                    reset_at: lastRaw.raw.rateLimit.resetAt,
                  },
                }
              : {}),
            ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
          });
          process.stdout.write(`${JSON.stringify(envelope)}\n`);
        }
      : undefined;

  let merged: NormalizedPage<TasklistFull>;
  try {
    merged = await fetchAllPages({
      fetchPage: fetchPageFn,
      ...(onPage !== undefined ? { onPage } : {}),
    });
  } catch (err: unknown) {
    if (err instanceof PartialPagesError) {
      // Mid-stream failure (spec §5). In ndjson we already emitted accumulated
      // pages; in json/human we now emit the partial merged envelope so an
      // agent can resume from paging.next_cursor === failedPage.
      if (mode !== 'ndjson') {
        const partial = err.accumulated as NormalizedPage<TasklistFull>;
        const data = buildEnvelopeData(
          scope,
          projectId,
          partial.data as ReadonlyArray<Record<string, unknown>>,
          requested,
        );
        const envelope = buildEnvelope({
          schema: 'freelo.tasklists.list/v1',
          data,
          paging: pagingFromNormalized(partial),
          ...(lastRaw !== undefined
            ? {
                rateLimit: {
                  remaining: lastRaw.raw.rateLimit.remaining,
                  reset_at: lastRaw.raw.rateLimit.resetAt,
                },
              }
            : {}),
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
          notice: `Partial result; iteration aborted at page ${err.failedPage}.`,
        });
        process.stdout.write(`${JSON.stringify(envelope)}\n`);
      }
      throw err.innerCause;
    }
    throw err;
  }

  if (mode === 'ndjson') {
    // Pages already emitted in onPage; nothing more to do.
    return;
  }

  const data = buildEnvelopeData(
    scope,
    projectId,
    merged.data as ReadonlyArray<Record<string, unknown>>,
    requested,
  );
  const envelope = buildEnvelope({
    schema: 'freelo.tasklists.list/v1',
    data,
    paging: pagingFromNormalized(merged),
    ...(lastRaw !== undefined
      ? {
          rateLimit: {
            remaining: lastRaw.raw.rateLimit.remaining,
            reset_at: lastRaw.raw.rateLimit.resetAt,
          },
        }
      : {}),
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  await renderAsync(mode, envelope, (d) =>
    renderTasklistsListHuman(d, requested ? { displayFields: requested } : {}),
  );
}
