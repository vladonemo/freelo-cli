import { type Command, InvalidArgumentError, Option } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  getOwnedProjects,
  getAllProjects,
  getInvitedProjects,
  getArchivedProjects,
  getTemplateProjects,
  type ProjectsListResult,
} from '../../api/projects.js';
import {
  fetchAllPages,
  pagingFromNormalized,
  PartialPagesError,
  projectFields,
  type NormalizedPage,
} from '../../api/pagination.js';
import {
  DEFAULT_FIELDS,
  type ProjectListData,
  type ProjectsScope,
} from '../../api/schemas/project.js';
import { buildEnvelope } from '../../ui/envelope.js';
import { renderAsync } from '../../ui/render.js';
import { renderProjectsListHuman } from '../../ui/human/projects-list.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';
import { parseFieldsFlag } from '../../lib/parse-fields.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.projects.list/v1',
  destructive: false,
};

const SCOPES = ['owned', 'invited', 'archived', 'templates', 'all'] as const;

type ListOpts = {
  scope: ProjectsScope;
  page?: number;
  all?: boolean;
  cursor?: number;
  fields?: string;
};

function parsePositiveInt(label: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError(`${label} must be a positive integer.`);
  }
  return n;
}

function parseNonNegativeInt(label: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new InvalidArgumentError(`${label} must be a non-negative integer.`);
  }
  return n;
}

export function registerList(
  projects: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = projects
    .command('list')
    .description("List projects in the chosen scope. Default scope is 'owned'.")
    .addOption(
      new Option('--scope <scope>', 'Which project set to list.')
        .choices([...SCOPES])
        .default('owned'),
    )
    .option('--page <n>', '1-indexed page number to fetch (single page).', (raw) =>
      parsePositiveInt('--page', raw),
    )
    .option('--all', 'Fetch every page client-side until exhausted.')
    .option(
      '--cursor <n>',
      'Resume at the cursor value reported by a prior envelope (0-indexed).',
      (raw) => parseNonNegativeInt('--cursor', raw),
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

      const scope = opts.scope;
      const requested = parseFieldsFlag(opts.fields);
      const knownFields = DEFAULT_FIELDS[scope];

      // Validate --fields BEFORE any HTTP call (spec §4.5).
      if (requested !== undefined) {
        // Empty / unknown / nested handled inside projectFields against an
        // empty record set (only the validation pass matters here).
        projectFields([] as Record<string, unknown>[], requested, knownFields, scope);
      }

      // --scope owned + --cursor n>=1 is "wrong protocol against unpaginated"
      // per spec §5; reject before the API call.
      if (scope === 'owned' && opts.cursor !== undefined && opts.cursor >= 1) {
        throw new ValidationError(`Scope 'owned' is unpaginated; --cursor must be 0 or omitted.`, {
          hintNext: "Scope 'owned' is unpaginated; use --cursor 0 or omit it.",
        });
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

      // --all path: iterate.
      if (opts.all === true) {
        await runAll({
          client,
          scope,
          requested,
          knownFields,
          mode,
          appConfig,
        });
        return;
      }

      // Single-page path (default, --page, or --cursor).
      const result = await fetchPage(client, scope, targetPage, appConfig);
      const data = buildEnvelopeData(scope, result.page.data, requested, knownFields);
      const envelope = buildEnvelope({
        schema: 'freelo.projects.list/v1',
        data,
        paging: pagingFromNormalized(result.page),
        rateLimit: {
          remaining: result.raw.rateLimit.remaining,
          reset_at: result.raw.rateLimit.resetAt,
        },
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      await renderAsync(mode, envelope, (d) =>
        renderProjectsListHuman(d, requested ? { displayFields: requested } : {}),
      );
    } catch (err: unknown) {
      handleTopLevelError(err, mode);
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
  scope: ProjectsScope,
  page: number,
  appConfig: PartialAppConfig,
): Promise<ProjectsListResult<Record<string, unknown>>> {
  const opts = appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {};
  switch (scope) {
    case 'owned':
      return (await getOwnedProjects(client, opts)) as ProjectsListResult<Record<string, unknown>>;
    case 'all':
      return (await getAllProjects(client, { ...opts, page })) as ProjectsListResult<
        Record<string, unknown>
      >;
    case 'invited':
      return (await getInvitedProjects(client, { ...opts, page })) as ProjectsListResult<
        Record<string, unknown>
      >;
    case 'archived':
      return (await getArchivedProjects(client, { ...opts, page })) as ProjectsListResult<
        Record<string, unknown>
      >;
    case 'templates':
      return (await getTemplateProjects(client, { ...opts, page })) as ProjectsListResult<
        Record<string, unknown>
      >;
  }
}

function buildEnvelopeData(
  scope: ProjectsScope,
  records: Record<string, unknown>[],
  requested: string[] | undefined,
  knownFields: readonly string[],
): ProjectListData {
  const entityShape = scope === 'all' ? 'full' : 'with_tasklists';
  const projected =
    requested !== undefined && requested.length > 0
      ? projectFields(records, requested, knownFields, scope)
      : records;

  if (entityShape === 'full') {
    return {
      entity_shape: 'full',
      scope: 'all',
      // Type relaxed: we passthrough validated upstream; the discriminated union
      // accepts the full ProjectFull set, which projection narrows but keeps
      // structurally compatible.
      projects: projected as ProjectListData['projects'],
    };
  }
  return {
    entity_shape: 'with_tasklists',
    scope: scope as Exclude<ProjectsScope, 'all'>,
    projects: projected as ProjectListData['projects'],
  };
}

async function runAll(opts: {
  client: HttpClient;
  scope: ProjectsScope;
  requested: string[] | undefined;
  knownFields: readonly string[];
  mode: 'human' | 'json' | 'ndjson';
  appConfig: PartialAppConfig;
}): Promise<void> {
  const { client, scope, requested, knownFields, mode, appConfig } = opts;

  // ndjson streams one envelope per page; json/human merge.
  let lastRaw: ProjectsListResult<Record<string, unknown>> | undefined;

  const fetchPageFn = async (p: number): Promise<NormalizedPage<Record<string, unknown>>> => {
    const r = await fetchPage(client, scope, p, appConfig);
    lastRaw = r;
    return r.page;
  };

  const onPage =
    mode === 'ndjson'
      ? (page: NormalizedPage<Record<string, unknown>>): void => {
          const data = buildEnvelopeData(scope, page.data, requested, knownFields);
          const envelope = buildEnvelope({
            schema: 'freelo.projects.list/v1',
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

  let merged: NormalizedPage<Record<string, unknown>>;
  try {
    merged = await fetchAllPages({
      fetchPage: fetchPageFn,
      ...(onPage !== undefined ? { onPage } : {}),
    });
  } catch (err: unknown) {
    if (err instanceof PartialPagesError) {
      // Mid-stream failure (spec §5). In ndjson we already emitted accumulated
      // pages; in json we now emit the partial merged envelope so an agent can
      // resume from paging.next_cursor === failedPage.
      if (mode !== 'ndjson') {
        const partial = err.accumulated as NormalizedPage<Record<string, unknown>>;
        const data = buildEnvelopeData(scope, partial.data, requested, knownFields);
        const envelope = buildEnvelope({
          schema: 'freelo.projects.list/v1',
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

  const data = buildEnvelopeData(scope, merged.data, requested, knownFields);
  const envelope = buildEnvelope({
    schema: 'freelo.projects.list/v1',
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
    renderProjectsListHuman(d, requested ? { displayFields: requested } : {}),
  );
}
