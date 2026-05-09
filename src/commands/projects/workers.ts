/**
 * `freelo projects workers list` and `freelo projects workers remove`
 * (R32, spec 0045).
 *
 * Sub-subcommand group: `projects workers <list|remove>`. Both leaves are
 * registered from this single file because they share the project-id parser
 * and live close together logically. The pattern mirrors
 * `src/commands/projects/transition.ts` (one file per tightly-coupled
 * subgroup).
 *
 * `list`:
 *   - GET /project/{id}/workers (paginated). Reuses `getProjectWorkers` from
 *     `src/api/projects.ts` (R04) and the shared `fetchAllPages` helper (R03).
 *   - `--page N` returns one page; `--all` (default — spec 0045 decision 7)
 *     iterates until `nextCursor === null`.
 *   - `--fields id,fullname` projection (decision 8).
 *
 * `remove`:
 *   - POST /project/{id}/remove-workers/by-{ids,emails}. One invocation =
 *     one HTTP call — the body is array-typed (decision 2). `--user` and
 *     `--email` are mutually exclusive (decision 3). Confirmation gates the
 *     destructive write via the shared `confirmDestructive` helper (R13).
 *   - `--dry-run` skips the POST AND the prompt (mirrors R13/R30).
 *   - Duplicates in `--user` / `--email` are deduplicated first-seen-wins
 *     before the wire call (decision 10).
 *   - No idempotency mapping — server errors surface as `FreeloApiError`
 *     (decision 6 — "don't guess the API"; the by-emails endpoint explicitly
 *     fails on emails-not-in-project, by-ids isn't documented as idempotent).
 *
 * Calibration §2: every typed error class triggered has an exit-code
 * asserting test.
 * Calibration §4: the new try/catch arms (PartialPagesError unwrap on list,
 * 400-owner hint rewrite on remove) have explicit coverage.
 * Calibration §7: tests asserting TTY-prompt copy clear `process.env['CI']`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { getProjectWorkers } from '../../api/projects.js';
import {
  removeProjectWorkersByIds,
  removeProjectWorkersByEmails,
  projectsWorkersRemoveByIdsPath,
  projectsWorkersRemoveByEmailsPath,
} from '../../api/projects-workers.js';
import {
  type ProjectsWorkersListData,
  type ProjectsWorkersRemoveData,
  type UserBasic,
} from '../../api/schemas/project.js';
import { fetchAllPages, pagingFromNormalized, type NormalizedPage } from '../../api/pagination.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderAsync, render } from '../../ui/render.js';
import {
  renderProjectsWorkersListHuman,
  renderProjectsWorkersRemoveHuman,
} from '../../ui/human/projects-workers.js';
import { confirmDestructive } from '../../lib/confirm.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

/* ===========================================================================
 *  Sub-subcommand registration
 * ========================================================================= */

/**
 * Register the `workers` subgroup on the `projects` parent. Wired from
 * `src/commands/projects.ts`.
 */
export function registerWorkers(
  projects: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const workers = projects.command('workers').description('Inspect and manage project membership.');

  registerWorkersList(workers, getConfig, env);
  registerWorkersRemove(workers, getConfig, env);
}

/* ===========================================================================
 *  Shared parsers
 * ========================================================================= */

function parsePositiveInt(label: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`${label} must be a positive integer.`, {
      hintNext: `${label} is a numeric id.`,
    });
  }
  return n;
}

function parseProjectIdFlag(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--project must be a positive integer.', {
      hintNext: '--project is the numeric project id from `freelo projects list`.',
    });
  }
  return n;
}

function parseNonNegativeInt(label: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new ValidationError(`${label} must be a non-negative integer.`, {
      hintNext: `${label} is a 0-indexed page number.`,
    });
  }
  return n;
}

/* ===========================================================================
 *  `workers list`
 * ========================================================================= */

const LIST_SCHEMA: SchemaString = 'freelo.projects.workers.list/v1';

const LIST_FIELDS_ALLOWED = ['id', 'fullname'] as const;
type ListField = (typeof LIST_FIELDS_ALLOWED)[number];

export const listMeta: CommandMeta = {
  outputSchema: LIST_SCHEMA,
  destructive: false,
};

type ListOpts = {
  project?: number;
  page?: number;
  all?: true;
  fields?: string;
};

function parseFieldsFlag(raw: string): readonly ListField[] {
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) {
    throw new ValidationError('--fields requires at least one field name.', {
      hintNext: `--fields accepts: ${LIST_FIELDS_ALLOWED.join(', ')}.`,
    });
  }
  const allowed = new Set<string>(LIST_FIELDS_ALLOWED);
  const seen = new Set<ListField>();
  const ordered: ListField[] = [];
  for (const t of tokens) {
    if (!allowed.has(t)) {
      throw new ValidationError(
        `Unknown --fields value '${t}'. Allowed: ${LIST_FIELDS_ALLOWED.join(', ')}.`,
        { hintNext: `--fields accepts only: ${LIST_FIELDS_ALLOWED.join(', ')}.` },
      );
    }
    if (!seen.has(t as ListField)) {
      seen.add(t as ListField);
      ordered.push(t as ListField);
    }
  }
  return ordered;
}

function registerWorkersList(
  workers: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = workers
    .command('list')
    .description(
      "List a project's workers (active members + owner + guests). Paginated; defaults to fetching all pages.",
    )
    .requiredOption('--project <id>', 'Numeric project id.', parseProjectIdFlag)
    .option(
      '--page <n>',
      '0-indexed page (mutex with default --all). Returns just one page.',
      (raw) => parseNonNegativeInt('--page', raw),
    )
    .option('--all', 'Fetch all pages (default behaviour; pass to be explicit).')
    .option(
      '--fields <list>',
      `Comma-separated columns. Allowed: ${LIST_FIELDS_ALLOWED.join(', ')}.`,
    );
  attachMeta(cmd, listMeta);

  cmd.action(async (opts: ListOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      const projectId = opts.project!;
      const displayFields =
        opts.fields !== undefined
          ? parseFieldsFlag(opts.fields)
          : (LIST_FIELDS_ALLOWED as readonly ListField[]);

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

      // Single-page mode (--page N) vs all-pages mode (default / --all).
      let merged: NormalizedPage<UserBasic>;
      let lastRaw: { rateLimit: { remaining: number | null; resetAt: string | null } } | undefined;

      if (opts.page !== undefined) {
        const r = await getProjectWorkers(client, projectId, {
          page: opts.page,
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        merged = r.page;
        lastRaw = r.raw;
      } else {
        merged = await fetchAllWorkers(client, projectId, appConfig, (raw) => {
          lastRaw = raw;
        });
      }

      const data: ProjectsWorkersListData = {
        project_id: projectId,
        workers: merged.data,
      };

      const envelope = buildEnvelope({
        schema: LIST_SCHEMA,
        data,
        paging: pagingFromNormalized(merged),
        ...(lastRaw !== undefined
          ? {
              rateLimit: {
                remaining: lastRaw.rateLimit.remaining,
                reset_at: lastRaw.rateLimit.resetAt,
              },
            }
          : {}),
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });

      await renderAsync(mode, envelope, (d) =>
        renderProjectsWorkersListHuman(d, { displayFields }),
      );
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/**
 * Iterate `?p=0, 1, ...` over `/project/{id}/workers` until exhausted,
 * returning the merged worker list. Mid-stream failure unwraps
 * `PartialPagesError` and re-throws the inner cause — `list` is a single-
 * object envelope, no partial result (decision 9, mirrors R04).
 *
 * Calibration §4: this catch arm (the PartialPagesError unwrap) is covered
 * by `mid-stream pagination failure` test in the list test file.
 */
async function fetchAllWorkers(
  client: HttpClient,
  projectId: number,
  appConfig: PartialAppConfig,
  onLastRaw: (raw: { rateLimit: { remaining: number | null; resetAt: string | null } }) => void,
): Promise<NormalizedPage<UserBasic>> {
  const fetchPageFn = async (p: number): Promise<NormalizedPage<UserBasic>> => {
    const r = await getProjectWorkers(client, projectId, {
      page: p,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    onLastRaw(r.raw);
    return r.page;
  };

  try {
    return await fetchAllPages({ fetchPage: fetchPageFn });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'PartialPagesError') {
      const inner = (err as unknown as { innerCause: unknown }).innerCause;
      throw inner;
    }
    throw err;
  }
}

/* ===========================================================================
 *  `workers remove`
 * ========================================================================= */

const REMOVE_SCHEMA: SchemaString = 'freelo.projects.workers.remove/v1';

export const removeMeta: CommandMeta = {
  outputSchema: REMOVE_SCHEMA,
  destructive: true,
};

type RemoveOpts = {
  project?: number;
  user?: number[];
  email?: string[];
  dryRun?: true;
};

/**
 * Loose email regex — mirrors the existing pattern in `auth login`. Server
 * is the authority; this catches obvious typos client-side.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function collectUserId(raw: string, prev: number[] | undefined): number[] {
  const n = parsePositiveInt('--user', raw);
  return prev ? [...prev, n] : [n];
}

function collectEmail(raw: string, prev: string[] | undefined): string[] {
  const trimmed = raw.trim();
  if (!EMAIL_RE.test(trimmed)) {
    throw new ValidationError(`--email '${raw}' is not a valid email address.`, {
      hintNext: '--email must be `local@domain`. Repeat the flag for multiple recipients.',
    });
  }
  return prev ? [...prev, trimmed] : [trimmed];
}

function registerWorkersRemove(
  workers: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = workers
    .command('remove')
    .description(
      'Remove one or more workers from a project. Atomic — the entire request fails if any single user cannot be removed (server-side ACL pre-check). The project owner cannot be removed via this command.',
    )
    .requiredOption('--project <id>', 'Numeric project id.', parseProjectIdFlag)
    .option(
      '--user <id>',
      'Numeric user id (repeatable). Mutex with --email. Removes via `POST /project/{id}/remove-workers/by-ids`.',
      collectUserId,
    )
    .option(
      '--email <addr>',
      'User email (repeatable). Mutex with --user. Removes via `POST /project/{id}/remove-workers/by-emails`.',
      collectEmail,
    )
    .option(
      '--dry-run',
      'Skip the POST and the confirmation prompt; envelope echoes the call that would have run.',
    );
  attachMeta(cmd, removeMeta);

  cmd.action(async (opts: RemoveOpts, cmdCtx: Command) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;
    const yes = resolveYesFlag(cmdCtx);

    try {
      const projectId = opts.project!;
      const { kind, ids, emails } = validateRemoveInput(opts);

      // ---- Dry-run: skip confirmation, skip POST. Emit envelope echo only.
      if (opts.dryRun === true) {
        const data = buildRemoveDryRunData(projectId, kind, ids, emails);
        const envelope: Envelope<ProjectsWorkersRemoveData> = {
          schema: REMOVE_SCHEMA,
          data,
          dry_run: true,
        };
        if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
        renderRemoveEnvelope(envelope, mode);
        return;
      }

      // ---- Live POST: confirm first, then build the client.
      const count = kind === 'ids' ? ids.length : emails.length;
      await confirmDestructive({
        promptMessage: confirmMessage(projectId, count),
        yes,
        dryRun: false,
      });

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

      try {
        const result =
          kind === 'ids'
            ? await removeProjectWorkersByIds(
                client,
                projectId,
                { users_ids: ids },
                {
                  ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
                },
              )
            : await removeProjectWorkersByEmails(
                client,
                projectId,
                { users_emails: emails },
                {
                  ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
                },
              );

        const data: ProjectsWorkersRemoveData =
          kind === 'ids'
            ? { project_id: projectId, removed_by: 'ids', users_ids: ids, count: ids.length }
            : {
                project_id: projectId,
                removed_by: 'emails',
                users_emails: emails,
                count: emails.length,
              };

        const envelope = buildEnvelope({
          schema: REMOVE_SCHEMA,
          data,
          rateLimit: {
            remaining: result.raw.rateLimit.remaining,
            reset_at: result.raw.rateLimit.resetAt,
          },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        renderRemoveEnvelope(envelope, mode);
      } catch (err: unknown) {
        throw rewriteRemoveApiHint(err, projectId, kind);
      }
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/**
 * Walk the Commander tree up to the root program and read the global `--yes`
 * flag. Mirrors `tasks/delete.ts:resolveYesFlag` byte-for-byte.
 */
function resolveYesFlag(cmd: Command): boolean {
  let cur: Command | null = cmd;
  while (cur && cur.parent) {
    cur = cur.parent;
  }
  if (cur === null) return false;
  const opts = cur.opts<{ yes?: boolean }>();
  return opts.yes === true;
}

/**
 * Validate the input source mutex and per-element values, returning the
 * normalized (deduplicated, in-order) array for whichever branch was given.
 *
 * - `--user` and `--email` are mutually exclusive (decision 3).
 * - At least one must be supplied.
 * - Duplicates are deduplicated first-seen-wins (decision 10).
 *
 * Throws `ValidationError` on any failure.
 */
function validateRemoveInput(
  opts: RemoveOpts,
):
  | { kind: 'ids'; ids: number[]; emails: string[] }
  | { kind: 'emails'; ids: number[]; emails: string[] } {
  const hasUser = opts.user !== undefined && opts.user.length > 0;
  const hasEmail = opts.email !== undefined && opts.email.length > 0;

  if (hasUser && hasEmail) {
    throw new ValidationError('--user and --email are mutually exclusive (different endpoints).', {
      hintNext: 'Pick one: --user <id>... OR --email <addr>... in a single invocation.',
    });
  }
  if (!hasUser && !hasEmail) {
    throw new ValidationError('No users to remove — pass --user <id> or --email <addr>.', {
      hintNext: 'Both flags are repeatable; values are sent in one HTTP request.',
    });
  }

  if (hasUser) {
    const ids = dedupNumbers(opts.user!);
    return { kind: 'ids', ids, emails: [] };
  }
  const emails = dedupStrings(opts.email!);
  return { kind: 'emails', ids: [], emails };
}

function dedupNumbers(arr: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const n of arr) {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

function dedupStrings(arr: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * Build the prompt copy for the destructive confirmation gate. Calibration §7
 * applies to any test asserting this string — clear `process.env['CI']`
 * before spoofing `isTTY`.
 */
function confirmMessage(projectId: number, count: number): string {
  const subject = count === 1 ? '1 worker' : `${count} workers`;
  return `Remove ${subject} from project #${projectId}? They lose access immediately and their task assignments in this project are cleared.`;
}

function buildRemoveDryRunData(
  projectId: number,
  kind: 'ids' | 'emails',
  ids: number[],
  emails: string[],
): ProjectsWorkersRemoveData {
  if (kind === 'ids') {
    return {
      project_id: projectId,
      removed_by: 'ids',
      users_ids: ids,
      count: ids.length,
      would: {
        method: 'POST',
        path: projectsWorkersRemoveByIdsPath(projectId),
        body: { users_ids: ids },
      },
    };
  }
  return {
    project_id: projectId,
    removed_by: 'emails',
    users_emails: emails,
    count: emails.length,
    would: {
      method: 'POST',
      path: projectsWorkersRemoveByEmailsPath(projectId),
      body: { users_emails: emails },
    },
  };
}

function renderRemoveEnvelope(
  envelope: Envelope<ProjectsWorkersRemoveData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  render(mode, envelope, (d) => renderProjectsWorkersRemoveHuman(d));
}

/**
 * Map a `FreeloApiError` thrown by the remove POST to a friendlier
 * `hintNext` for 400 / 403 / 404. Mirrors `projects show`'s `rewriteApiHint`
 * (spec 0013 §3.5).
 *
 * Calibration §4: this is one of the new try/catch arms; covered by tests
 * (owner-removal 400 hint, 403 permission hint, 404 project-not-found hint).
 */
function rewriteRemoveApiHint(err: unknown, projectId: number, kind: 'ids' | 'emails'): unknown {
  if (!(err instanceof FreeloApiError)) return err;

  if (err.httpStatus === 400) {
    // Specialized hint when the message references the project owner
    // (decision 11). The check is loose — Freelo doesn't expose a stable
    // error code, just a human message. We scan both `err.message` (which
    // may be the synthetic "Freelo API error (HTTP 400)." from
    // `FreeloApiError.fromResponse`) AND `err.errors[]` (which carries the
    // server-supplied human strings).
    const haystack = [err.message, ...(err.errors ?? [])].join(' ');
    const mentionsOwner = /owner/i.test(haystack);
    const hintNext = mentionsOwner
      ? 'Project owner cannot be removed via this command. Transfer ownership first (Wave 6 surface), then re-run.'
      : kind === 'emails'
        ? 'Every email must currently be a worker on this project (server-side pre-check). Verify with `freelo projects workers list --project <id>`.'
        : 'Verify the user ids exist and are workers on this project (try `freelo projects workers list --project <id>`).';
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext,
    });
  }
  if (err.httpStatus === 403) {
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: `Account does not have permission to remove workers from project ${projectId}.`,
    });
  }
  if (err.httpStatus === 404) {
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: `Project ${projectId} not found, or your account does not have access.`,
    });
  }
  return err;
}
