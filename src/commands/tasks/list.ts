import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  getAllTasks,
  getTasklistActiveTasks,
  type AllTasksFilters,
  type TasksListResult,
} from '../../api/tasks.js';
import {
  fetchAllPages,
  pagingFromNormalized,
  PartialPagesError,
  projectFields,
  type NormalizedPage,
} from '../../api/pagination.js';
import {
  TASK_FULL_DEFAULT_FIELDS,
  TASK_SUMMARY_DEFAULT_FIELDS,
  type AppliedFilters,
  type EndpointKey,
  type TaskEntityShape,
  type TaskFull,
  type TaskListData,
  type TaskSummary,
} from '../../api/schemas/task.js';
import { buildEnvelope } from '../../ui/envelope.js';
import { renderAsync } from '../../ui/render.js';
import { renderTasksListHuman } from '../../ui/human/tasks-list.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';
import { parseFieldsFlag } from '../../lib/parse-fields.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.list/v1',
  destructive: false,
};

/**
 * Internal opts shape used after Commander parsing.
 *
 * `noDue` is the *normalized* form used by `resolveRoute`,
 * `buildAppliedFilters`, and `filtersForAllTasks`. The action handler
 * derives it from Commander's negation form of `--no-due` (which sets
 * `due === false` when the flag is present).
 */
type ListOpts = {
  project?: number[];
  tasklist?: number[];
  worker?: number;
  state?: number;
  label?: string[];
  withoutLabel?: string;
  dueFrom?: string;
  dueTo?: string;
  noDue?: boolean;
  finishedOverdue?: boolean;
  finishedFrom?: string;
  finishedTo?: string;
  search?: string;
  orderBy?: 'priority' | 'name' | 'date_add' | 'date_edited_at';
  order?: 'asc' | 'desc';
  page?: number;
  all?: boolean;
  cursor?: number;
  fields?: string;
};

/**
 * Commander assigns `--no-due` to the property `due` with value `false`.
 * This is the raw shape the action handler receives before normalization.
 */
type RawListOpts = Omit<ListOpts, 'noDue'> & { due?: boolean };

/**
 * Parse a positive-integer flag. Throws `ValidationError` (BaseError, exit 2)
 * — NOT Commander's `InvalidArgumentError` which would map to exit 1.
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

/**
 * Variadic positive-int collector — Commander invokes the parser once per
 * occurrence of `--foo <id>`. Returns the accumulated array.
 */
function collectPositiveInt(label: string) {
  return (raw: string, prev: number[] | undefined): number[] => {
    const n = parsePositiveIntFlag(label, `${label} must be a positive integer (numeric id).`, raw);
    return prev ? [...prev, n] : [n];
  };
}

/**
 * Variadic string collector with empty-string rejection. Used for `--label`.
 */
function collectNonEmptyString(label: string) {
  return (raw: string, prev: string[] | undefined): string[] => {
    if (raw.length === 0) {
      throw new ValidationError(`${label} cannot be empty.`, {
        hintNext: `${label} takes a non-empty value (e.g. --label bug).`,
      });
    }
    return prev ? [...prev, raw] : [raw];
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a strict ISO date (`YYYY-MM-DD`). Rejects non-matching format and
 * dates that pass the regex but yield NaN from `Date.parse` (e.g. `2026-13-01`).
 */
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

function parseEnumFlag<T extends string>(label: string, allowed: readonly T[], raw: string): T {
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ValidationError(`${label} must be one of: ${allowed.join(', ')}.`, {
      hintNext: `${label} valid values: ${allowed.join(', ')}.`,
    });
  }
  return raw as T;
}

/**
 * Pure route-resolution function — exported for unit-testing.
 *
 * Spec 0017 §2.2 dispatch tree. Two routes in v1:
 *  - `/project/{p}/tasklist/{t}/tasks` ←
 *      exactly one `--project`, exactly one `--tasklist`, no other filters
 *      that the per-tasklist route can't honor (only `--order-by`/`--order`
 *      are allowed there).
 *  - `/all-tasks` ← every other combination.
 *
 * The third route (`/tasklist/{id}/finished-tasks`) is deferred to R07.5
 * per spec OQ #4.
 */
export function resolveRoute(opts: ListOpts): {
  endpoint: EndpointKey;
  entityShape: TaskEntityShape;
} {
  const oneProject = (opts.project ?? []).length === 1;
  const oneTasklist = (opts.tasklist ?? []).length === 1;

  // Filters that /project/{p}/tasklist/{t}/tasks does NOT honor.
  // Anything set here forces /all-tasks.
  const hasUnsupportedFilter =
    opts.worker !== undefined ||
    opts.state !== undefined ||
    (opts.label !== undefined && opts.label.length > 0) ||
    opts.withoutLabel !== undefined ||
    opts.dueFrom !== undefined ||
    opts.dueTo !== undefined ||
    opts.noDue === true ||
    opts.finishedOverdue === true ||
    opts.finishedFrom !== undefined ||
    opts.finishedTo !== undefined ||
    opts.search !== undefined;

  if (oneProject && oneTasklist && !hasUnsupportedFilter) {
    return { endpoint: 'tasklist-tasks', entityShape: 'task_summary' };
  }
  return { endpoint: 'all-tasks', entityShape: 'task_full' };
}

/**
 * Build the `applied_filters` echo from the user's parsed opts. Boolean
 * keys are emitted only when `true` — never `false` — to match wire shape.
 */
function buildAppliedFilters(opts: ListOpts): AppliedFilters {
  const out: AppliedFilters = {};
  if (opts.project !== undefined && opts.project.length > 0) out.projects = opts.project;
  if (opts.tasklist !== undefined && opts.tasklist.length > 0) out.tasklists = opts.tasklist;
  if (opts.worker !== undefined) out.worker = opts.worker;
  if (opts.state !== undefined) out.state = opts.state;
  if (opts.label !== undefined && opts.label.length > 0) out.labels = opts.label;
  if (opts.withoutLabel !== undefined) out.without_label = opts.withoutLabel;
  if (opts.dueFrom !== undefined) out.due_from = opts.dueFrom;
  if (opts.dueTo !== undefined) out.due_to = opts.dueTo;
  if (opts.noDue === true) out.no_due = true;
  if (opts.finishedOverdue === true) out.finished_overdue = true;
  if (opts.finishedFrom !== undefined) out.finished_from = opts.finishedFrom;
  if (opts.finishedTo !== undefined) out.finished_to = opts.finishedTo;
  if (opts.search !== undefined) out.search = opts.search;
  if (opts.orderBy !== undefined) out.order_by = opts.orderBy;
  if (opts.order !== undefined) out.order = opts.order;
  return out;
}

function defaultFieldsFor(shape: TaskEntityShape): readonly string[] {
  return shape === 'task_summary' ? TASK_SUMMARY_DEFAULT_FIELDS : TASK_FULL_DEFAULT_FIELDS;
}

export function registerList(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = tasks
    .command('list')
    .description('List tasks across all projects (default) or scoped to one project + tasklist.')
    .option(
      '--project <id>',
      'Filter to tasks in this project (numeric id; repeat for OR).',
      collectPositiveInt('--project'),
    )
    .option(
      '--tasklist <id>',
      'Filter to tasks in this tasklist (numeric id; repeat for OR).',
      collectPositiveInt('--tasklist'),
    )
    .option('--worker <id>', 'Filter to tasks assigned to this worker (numeric id).', (raw) =>
      parsePositiveIntFlag(
        '--worker',
        '--worker is the numeric user id from `freelo projects show <id> --with workers`.',
        raw,
      ),
    )
    .option('--state <id>', 'Filter to tasks in this state (numeric id).', (raw) =>
      parsePositiveIntFlag('--state', '--state takes a numeric state id.', raw),
    )
    .option(
      '--label <name>',
      'Filter to tasks carrying this label (repeat for OR).',
      collectNonEmptyString('--label'),
    )
    .option('--without-label <name>', 'Filter out tasks carrying this label.')
    .option('--due-from <date>', 'Filter to tasks with due_date >= this (YYYY-MM-DD).', (raw) =>
      parseDateFlag('--due-from', raw),
    )
    .option('--due-to <date>', 'Filter to tasks with due_date <= this (YYYY-MM-DD).', (raw) =>
      parseDateFlag('--due-to', raw),
    )
    .option('--no-due', 'Filter to tasks with no due date set.')
    .option('--finished-overdue', 'Filter to tasks finished after their due date.')
    .option(
      '--finished-from <date>',
      'Filter to tasks finished on or after this date (YYYY-MM-DD).',
      (raw) => parseDateFlag('--finished-from', raw),
    )
    .option(
      '--finished-to <date>',
      'Filter to tasks finished on or before this date (YYYY-MM-DD).',
      (raw) => parseDateFlag('--finished-to', raw),
    )
    .option('--search <query>', 'Free-text search query.')
    .option(
      '--order-by <field>',
      'Order results by: priority, name, date_add, date_edited_at.',
      (raw) =>
        parseEnumFlag(
          '--order-by',
          ['priority', 'name', 'date_add', 'date_edited_at'] as const,
          raw,
        ),
    )
    .option('--order <dir>', 'Order direction: asc or desc.', (raw) =>
      parseEnumFlag('--order', ['asc', 'desc'] as const, raw),
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

  cmd.action(async (raw: RawListOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    // Normalize Commander's `--no-due` → `due === false` to our `noDue: true`.
    // When the flag is absent, Commander leaves `due` as `undefined`.
    const opts: ListOpts = {
      ...raw,
      ...(raw.due === false ? { noDue: true } : {}),
    };
    // Strip the raw `due` key so it doesn't leak into downstream logic.
    delete (opts as Record<string, unknown>)['due'];

    try {
      // --- mutex checks ---------------------------------------------------
      const pageMutex: string[] = [];
      if (opts.page !== undefined) pageMutex.push('--page');
      if (opts.all === true) pageMutex.push('--all');
      if (opts.cursor !== undefined) pageMutex.push('--cursor');
      if (pageMutex.length > 1) {
        throw new ValidationError('Flags --page, --all, and --cursor are mutually exclusive.', {
          hintNext: 'Pick one of --page, --all, or --cursor.',
        });
      }

      if (opts.noDue === true && (opts.dueFrom !== undefined || opts.dueTo !== undefined)) {
        throw new ValidationError('--no-due cannot be combined with --due-from or --due-to.', {
          hintNext: 'Pick either --no-due or a --due-from/--due-to range.',
        });
      }

      // --- route resolution ----------------------------------------------
      const route = resolveRoute(opts);

      // --search is not supported on the per-tasklist active route.
      if (route.endpoint === 'tasklist-tasks' && opts.search !== undefined) {
        // (unreachable in practice — resolveRoute already routes search to /all-tasks
        // — but kept as a defensive guard to avoid silent filter loss.)
        /* c8 ignore next 4 */
        throw new ValidationError(
          '--search is not supported when listing tasks of a single tasklist.',
          { hintNext: 'Drop --project to use /all-tasks, or drop --search.' },
        );
      }
      // The opposite case: user passed --search with --project AND --tasklist;
      // resolveRoute kept us on tasklist-tasks because no other unsupported filter
      // was set. Detect that explicitly here so the user sees a clear error.
      if (
        opts.search !== undefined &&
        (opts.project ?? []).length === 1 &&
        (opts.tasklist ?? []).length === 1 &&
        // Only this combination strands --search.
        opts.worker === undefined &&
        opts.state === undefined &&
        (opts.label === undefined || opts.label.length === 0) &&
        opts.withoutLabel === undefined &&
        opts.dueFrom === undefined &&
        opts.dueTo === undefined &&
        opts.noDue !== true &&
        opts.finishedOverdue !== true &&
        opts.finishedFrom === undefined &&
        opts.finishedTo === undefined
      ) {
        throw new ValidationError(
          '--search is not supported when listing tasks of a single tasklist.',
          {
            hintNext: 'Drop --project to use /all-tasks, or drop --search.',
          },
        );
      }

      // --- field projection validation -----------------------------------
      const requested = parseFieldsFlag(opts.fields);
      const knownFields = defaultFieldsFor(route.entityShape);
      if (requested !== undefined) {
        projectFields([] as Record<string, unknown>[], requested, knownFields, route.entityShape);
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

      const targetPage = computeTargetPage(opts);
      const appliedFilters = buildAppliedFilters(opts);

      // --- /project/{p}/tasklist/{t}/tasks (unpaginated) -----------------
      if (route.endpoint === 'tasklist-tasks') {
        const projectId = (opts.project ?? [])[0]!;
        const tasklistId = (opts.tasklist ?? [])[0]!;

        // --all on the unpaginated route is a no-op (terminate after one fetch),
        // mirroring R03's `--scope owned --all` precedent.
        if (opts.cursor !== undefined && opts.cursor !== 0) {
          throw new ValidationError('This route is unpaginated; --cursor must be 0 or omitted.', {
            hintNext: 'Use --cursor 0 or drop --cursor entirely.',
          });
        }

        const result = await getTasklistActiveTasks(client, {
          projectId,
          tasklistId,
          ...(opts.orderBy !== undefined ? { orderBy: opts.orderBy } : {}),
          ...(opts.order !== undefined ? { order: opts.order } : {}),
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        const data = buildEnvelopeData(
          'tasklist-tasks',
          'task_summary',
          appliedFilters,
          result.page.data as ReadonlyArray<Record<string, unknown>>,
          requested,
          knownFields,
        );
        const envelope = buildEnvelope({
          schema: 'freelo.tasks.list/v1',
          data,
          paging: pagingFromNormalized(result.page),
          rateLimit: {
            remaining: result.raw.rateLimit.remaining,
            reset_at: result.raw.rateLimit.resetAt,
          },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        await renderAsync(mode, envelope, (d) =>
          renderTasksListHuman(d, requested ? { displayFields: requested } : {}),
        );
        return;
      }

      // --- /all-tasks (paginated) ----------------------------------------
      const filters = filtersForAllTasks(opts);

      if (opts.all === true) {
        await runAll({
          client,
          filters,
          appliedFilters,
          requested,
          knownFields,
          mode,
          appConfig,
        });
        return;
      }

      const result = await getAllTasks(client, {
        page: targetPage,
        filters,
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      const data = buildEnvelopeData(
        'all-tasks',
        'task_full',
        appliedFilters,
        result.page.data as ReadonlyArray<Record<string, unknown>>,
        requested,
        knownFields,
      );
      const envelope = buildEnvelope({
        schema: 'freelo.tasks.list/v1',
        data,
        paging: pagingFromNormalized(result.page),
        rateLimit: {
          remaining: result.raw.rateLimit.remaining,
          reset_at: result.raw.rateLimit.resetAt,
        },
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      await renderAsync(mode, envelope, (d) =>
        renderTasksListHuman(d, requested ? { displayFields: requested } : {}),
      );
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

function computeTargetPage(opts: ListOpts): number {
  if (opts.page !== undefined) return opts.page - 1;
  if (opts.cursor !== undefined) return opts.cursor;
  return 0;
}

function filtersForAllTasks(opts: ListOpts): AllTasksFilters {
  const f: AllTasksFilters = {};
  if (opts.project !== undefined && opts.project.length > 0) f.projects = opts.project;
  if (opts.tasklist !== undefined && opts.tasklist.length > 0) f.tasklists = opts.tasklist;
  if (opts.worker !== undefined) f.worker = opts.worker;
  if (opts.state !== undefined) f.state = opts.state;
  if (opts.label !== undefined && opts.label.length > 0) f.labels = opts.label;
  if (opts.withoutLabel !== undefined) f.withoutLabel = opts.withoutLabel;
  if (opts.dueFrom !== undefined) f.dueFrom = opts.dueFrom;
  if (opts.dueTo !== undefined) f.dueTo = opts.dueTo;
  if (opts.noDue === true) f.noDue = true;
  if (opts.finishedOverdue === true) f.finishedOverdue = true;
  if (opts.finishedFrom !== undefined) f.finishedFrom = opts.finishedFrom;
  if (opts.finishedTo !== undefined) f.finishedTo = opts.finishedTo;
  if (opts.search !== undefined) f.search = opts.search;
  if (opts.orderBy !== undefined) f.orderBy = opts.orderBy;
  if (opts.order !== undefined) f.order = opts.order;
  return f;
}

function buildEnvelopeData(
  endpoint: EndpointKey,
  entityShape: TaskEntityShape,
  appliedFilters: AppliedFilters,
  records: ReadonlyArray<Record<string, unknown>>,
  requested: string[] | undefined,
  knownFields: readonly string[],
): TaskListData {
  const projected =
    requested !== undefined && requested.length > 0
      ? projectFields(records, requested, knownFields, entityShape)
      : records;
  if (endpoint === 'tasklist-tasks') {
    return {
      endpoint: 'tasklist-tasks',
      entity_shape: 'task_summary',
      applied_filters: appliedFilters,
      tasks: projected as TaskSummary[],
    };
  }
  return {
    endpoint: 'all-tasks',
    entity_shape: 'task_full',
    applied_filters: appliedFilters,
    tasks: projected as TaskFull[],
  };
}

async function runAll(opts: {
  client: HttpClient;
  filters: AllTasksFilters;
  appliedFilters: AppliedFilters;
  requested: string[] | undefined;
  knownFields: readonly string[];
  mode: 'human' | 'json' | 'ndjson';
  appConfig: PartialAppConfig;
}): Promise<void> {
  const { client, filters, appliedFilters, requested, knownFields, mode, appConfig } = opts;

  let lastRaw: TasksListResult<TaskFull> | undefined;

  const fetchPageFn = async (p: number): Promise<NormalizedPage<TaskFull>> => {
    const r = await getAllTasks(client, {
      page: p,
      filters,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    lastRaw = r;
    return r.page;
  };

  const onPage =
    mode === 'ndjson'
      ? (page: NormalizedPage<TaskFull>): void => {
          const data = buildEnvelopeData(
            'all-tasks',
            'task_full',
            appliedFilters,
            page.data as ReadonlyArray<Record<string, unknown>>,
            requested,
            knownFields,
          );
          const envelope = buildEnvelope({
            schema: 'freelo.tasks.list/v1',
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

  let merged: NormalizedPage<TaskFull>;
  try {
    merged = await fetchAllPages({
      fetchPage: fetchPageFn,
      ...(onPage !== undefined ? { onPage } : {}),
    });
  } catch (err: unknown) {
    if (err instanceof PartialPagesError) {
      if (mode !== 'ndjson') {
        const partial = err.accumulated as NormalizedPage<TaskFull>;
        const data = buildEnvelopeData(
          'all-tasks',
          'task_full',
          appliedFilters,
          partial.data as ReadonlyArray<Record<string, unknown>>,
          requested,
          knownFields,
        );
        const envelope = buildEnvelope({
          schema: 'freelo.tasks.list/v1',
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

  if (mode === 'ndjson') return;

  const data = buildEnvelopeData(
    'all-tasks',
    'task_full',
    appliedFilters,
    merged.data as ReadonlyArray<Record<string, unknown>>,
    requested,
    knownFields,
  );
  const envelope = buildEnvelope({
    schema: 'freelo.tasks.list/v1',
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
    renderTasksListHuman(d, requested ? { displayFields: requested } : {}),
  );
}
