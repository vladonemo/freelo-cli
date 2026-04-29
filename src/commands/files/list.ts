/**
 * `freelo files list` (R26, spec 0038).
 *
 * Lists every directory, link, file, and document the caller can see across
 * accessible projects, with optional filters by project and item type. Maps
 * to `GET /all-docs-and-files`.
 *
 * The roadmap line names a `--task <id>` filter but the endpoint does not
 * accept one (only `projects_ids[]`, `type`, `p` per OpenAPI :3925-3937).
 * `--task` is deferred — see
 * `docs/decisions/2026-04-29-1756-r26-files-list-1-defer-task.md`.
 *
 * Flags:
 *   --project <id> (repeat) — projects_ids[]
 *   --type <kind>           — wire enum, accepts CLI short forms only:
 *                             doc → document, dir → directory,
 *                             file → file, link → link  (decision 02)
 *   --page <n>              — 1-indexed CLI → 0-indexed wire; mutex with --all
 *   --all                   — iterate every page client-side
 *
 * Output schema: `freelo.files.list/v1`.
 *
 * Spec 0038 §3.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  getAllDocsAndFiles,
  type AllDocsAndFilesFilters,
  type FilesListResult,
} from '../../api/files.js';
import {
  fetchAllPages,
  pagingFromNormalized,
  PartialPagesError,
  type NormalizedPage,
} from '../../api/pagination.js';
import {
  type FileItem,
  type FileItemType,
  type FilesListAppliedFilters,
  type FilesListData,
} from '../../api/schemas/file.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { renderAsync } from '../../ui/render.js';
import { renderFilesListHuman } from '../../ui/human/files-list.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.files.list/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.files.list/v1';

type ListOpts = {
  project?: number[];
  type?: FileItemType;
  page?: number;
  all?: boolean;
};

/**
 * CLI short-form → wire enum mapping (decision 02). The four CLI keys are
 * the only valid values; everything else (including the wire forms
 * `document` / `directory`) raises `ValidationError`.
 */
const TYPE_MAP: Readonly<Record<string, FileItemType>> = Object.freeze({
  doc: 'document',
  file: 'file',
  link: 'link',
  dir: 'directory',
});

const VALID_TYPE_CLI_FORMS = Object.keys(TYPE_MAP).join(', ');

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

function parseTypeFlag(raw: string): FileItemType {
  const wire = TYPE_MAP[raw];
  if (wire === undefined) {
    throw new ValidationError(`--type must be one of: ${VALID_TYPE_CLI_FORMS}.`, {
      hintNext: `Valid CLI short forms: ${VALID_TYPE_CLI_FORMS}.`,
    });
  }
  return wire;
}

/**
 * Build the `applied_filters` echo from the user's parsed opts. Only keys
 * the user explicitly set are emitted. `type` carries the **wire form**
 * (decision 03).
 */
function buildAppliedFilters(opts: ListOpts): FilesListAppliedFilters {
  const out: FilesListAppliedFilters = {};
  if (opts.project !== undefined && opts.project.length > 0) out.projects = opts.project;
  if (opts.type !== undefined) out.type = opts.type;
  return out;
}

function filtersForWire(opts: ListOpts): AllDocsAndFilesFilters {
  const f: AllDocsAndFilesFilters = {};
  if (opts.project !== undefined && opts.project.length > 0) f.projects = opts.project;
  if (opts.type !== undefined) f.type = opts.type;
  return f;
}

export function registerList(
  files: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = files
    .command('list')
    .description(
      'List every directory, link, file, and document the caller can see (paginated). Filter by --project / --type. No --task filter — endpoint does not surface one.',
    )
    .option(
      '--project <id>',
      'Filter to assets under this project (numeric id; repeat for OR).',
      collectPositiveInt('--project'),
    )
    .option(
      '--type <kind>',
      'Filter to one item type. CLI short forms: doc | file | link | dir.',
      parseTypeFlag,
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

      // Default and `--page N` paths share single-page logic.
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
  filters: AllDocsAndFilesFilters;
  appliedFilters: FilesListAppliedFilters;
  appConfig: PartialAppConfig;
}): Promise<void> {
  const { client, targetPage, filters, appliedFilters, appConfig } = opts;
  const mode = appConfig.output.mode;

  const result = await getAllDocsAndFiles(client, {
    page: targetPage,
    filters,
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });

  const data: FilesListData = {
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
  await renderAsync(mode, envelope, (d) => renderFilesListHuman(d));
}

/**
 * `--all` path. Iterates `?p=0, 1, …` via `fetchAllPages`. No client-side
 * post-filter — `--project` / `--type` are server-side filters.
 *
 * On mid-stream failure after at least one successful page, emits a partial-
 * result envelope (with `notice`) before re-throwing the underlying cause —
 * mirrors R03 / R16 / R21 `runAll` behavior.
 */
async function runAll(opts: {
  client: HttpClient;
  filters: AllDocsAndFilesFilters;
  appliedFilters: FilesListAppliedFilters;
  appConfig: PartialAppConfig;
}): Promise<void> {
  const { client, filters, appliedFilters, appConfig } = opts;
  const mode = appConfig.output.mode;

  let lastResult: FilesListResult | undefined;

  const fetchPageFn = async (p: number): Promise<NormalizedPage<FileItem>> => {
    const r = await getAllDocsAndFiles(client, {
      page: p,
      filters,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    lastResult = r;
    return r.page;
  };

  let merged: NormalizedPage<FileItem>;
  try {
    merged = await fetchAllPages({ fetchPage: fetchPageFn });
  } catch (err: unknown) {
    if (err instanceof PartialPagesError) {
      // `lastResult` is guaranteed defined: PartialPagesError is only thrown
      // after at least one successful page fetched.
      const partial = err.accumulated as NormalizedPage<FileItem>;
      const data: FilesListData = {
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
      await renderAsync(mode, envelope, (d) => renderFilesListHuman(d));
      throw err.innerCause;
    }
    throw err;
  }

  const data: FilesListData = {
    applied_filters: appliedFilters,
    items: merged.data,
  };
  const envelope = buildEnvelope({
    schema: SCHEMA,
    data,
    paging: pagingFromNormalized(merged),
    // `lastResult` guaranteed defined: fetchAllPages returns only after a
    // terminating page (or throws).
    rateLimit: {
      remaining: lastResult!.raw.rateLimit.remaining,
      reset_at: lastResult!.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  await renderAsync(mode, envelope, (d) => renderFilesListHuman(d));
}
