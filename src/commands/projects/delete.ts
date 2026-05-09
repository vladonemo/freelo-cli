/**
 * `freelo projects delete <id>...` (R30, spec 0043).
 *
 * Mirrors `tasks delete` (R13, spec 0024) — same destructive command shape,
 * same shared `confirmDestructive` helper, same 404-as-idempotent
 * re-classification. Per-resource changes:
 *   - Wire path is `/project/{id}` (R13 was `/task/{id}`).
 *   - Confirm prompt copy mentions soft-delete reversibility (decision 6 —
 *     project delete IS reversible via `freelo projects activate`, unlike
 *     task delete which is also soft but lacks an exposed CLI restore verb).
 *   - Per-line context key is `project_id` (R13 was `task_id`).
 *
 * Surfaces:
 *   - Single id positional: `projects delete 9001 --yes`.
 *   - Multi positional: `projects delete 9001 9002 9003 --yes`.
 *   - `--ids "1,2,3"` flag (mutex with positional and `--stdin`).
 *   - `--stdin` NDJSON (mutex with positional and `--ids`).
 *   - `--dry-run` (any input source) — skips the wire call AND the
 *     confirmation prompt (no destructive effect).
 *   - `--yes` (global flag) — bypasses the confirmation prompt.
 *
 * Confirmation policy (spec 0043 §3.4):
 *   - `--yes` → unconditional proceed.
 *   - `--dry-run` → unconditional proceed (no destructive effect).
 *   - TTY without `--yes` → prompt once for the whole run (N projects).
 *     User declines → throw `ConfirmationError` (exit 2), no wire calls.
 *   - Non-TTY without `--yes` → throw `ConfirmationError` (exit 2)
 *     immediately, no wire calls.
 *
 * Idempotency (spec 0043 §3.3 / decision 4):
 *   - DELETE returns 404 → re-classified as success-with-
 *     `already_in_target_state: true`. The project was already deleted.
 *   - No GET pre-check (decision 1): paying 2 round-trips for a destructive
 *     op is not justified by the marginal "previous_state" information.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { deleteProject, projectDeletePath } from '../../api/projects-delete.js';
import { type ProjectsDeleteData } from '../../api/schemas/project.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderProjectsDeleteHuman } from '../../ui/human/projects-delete.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import { confirmDestructive } from '../../lib/confirm.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.projects.delete/v1',
  destructive: true,
};

const SCHEMA: SchemaString = 'freelo.projects.delete/v1';

type DeleteOpts = {
  ids?: string;
  stdin?: true;
  dryRun?: true;
};

/* ---------------------------------------------------------------------------
 *  Per-line NDJSON schema (--stdin batch mode). Mirrors R11/R13 — only `id`
 *  is required, no extra keys allowed.
 * ------------------------------------------------------------------------- */

const BatchLineSchema = z
  .object({
    id: z.number().int('id must be an integer (no string-form).').positive('id must be ≥ 1.'),
  })
  .strict();

/* ---------------------------------------------------------------------------
 *  Input parsing
 * ------------------------------------------------------------------------- */

function parsePositiveInt(label: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`${label} must be a positive integer.`, {
      hintNext: `${label} is the numeric project id from \`freelo projects list\`.`,
    });
  }
  return n;
}

function collectProjectId(raw: string, prev: number[] | undefined): number[] {
  const n = parsePositiveInt('<id>', raw);
  return prev ? [...prev, n] : [n];
}

function parseIdsFlag(raw: string): number[] {
  const tokens = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) {
    throw new ValidationError('--ids requires at least one id.', {
      hintNext: '--ids takes a comma- or space-separated list of numeric project ids.',
    });
  }
  return tokens.map((t) => parsePositiveInt('--ids', t));
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerDelete(
  projects: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = projects
    .command('delete')
    .description(
      "Soft-delete one or more projects. Destructive — requires --yes (non-TTY) or interactive confirmation (TTY). Reversible via 'freelo projects activate'. 404-after-delete is treated as idempotent already-deleted.",
    )
    .argument('[id...]', 'One or more numeric project ids (positional).', collectProjectId)
    .option(
      '--ids <list>',
      'Comma- or space-separated list of project ids (mutex with positional <id> and --stdin).',
    )
    .option(
      '--stdin',
      'Read NDJSON from stdin (one `{"id": <int>}` per line). Mutex with positional and --ids.',
    )
    .option(
      '--dry-run',
      'Skip the DELETE per id. No confirmation prompt fires. Envelope reflects what *would* have been called.',
    );
  // NOTE: `--yes` / `-y` is the **global** flag (registered on the root
  // program in `src/bin/freelo.ts`). Walk the Commander tree to read it.
  attachMeta(cmd, meta);

  cmd.action(async (ids: number[] | undefined, opts: DeleteOpts, cmdCtx: Command) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;
    const yes = resolveYesFlag(cmdCtx);

    try {
      validateInputSources(ids, opts);

      if (opts.stdin === true) {
        await runBatchFromStdin(opts, yes, appConfig, env);
        return;
      }

      const resolvedIds =
        ids !== undefined && ids.length > 0
          ? ids
          : opts.ids !== undefined
            ? parseIdsFlag(opts.ids)
            : [];

      if (resolvedIds.length === 0) {
        // No ids resolved → silent success exit 0 (matches R09/R11/R13).
        return;
      }

      await runIdList(resolvedIds, opts, yes, appConfig, env);
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

/* ---------------------------------------------------------------------------
 *  Cross-source validation (mirrors R11 / R13)
 * ------------------------------------------------------------------------- */

function validateInputSources(ids: number[] | undefined, opts: DeleteOpts): void {
  const hasPositional = ids !== undefined && ids.length > 0;
  const hasIdsFlag = opts.ids !== undefined && opts.ids.trim().length > 0;
  const hasStdin = opts.stdin === true;
  const sourceCount = (hasPositional ? 1 : 0) + (hasIdsFlag ? 1 : 0) + (hasStdin ? 1 : 0);
  if (sourceCount > 1) {
    throw new ValidationError(
      'Pick exactly one input source: positional <id>..., --ids, or --stdin.',
      {
        hintNext: 'Combining input sources is ambiguous — agents should pre-resolve to one shape.',
      },
    );
  }
  if (sourceCount === 0) {
    throw new ValidationError('No project ids supplied.', {
      hintNext: 'Pass numeric ids positionally, or use --ids "a,b,c", or pipe NDJSON to --stdin.',
    });
  }
}

/* ---------------------------------------------------------------------------
 *  Batch from positional / --ids
 *
 *  Confirmation fires once for the whole run (mirrors R13 spec 0024 §3.5).
 * ------------------------------------------------------------------------- */

async function runIdList(
  ids: readonly number[],
  opts: DeleteOpts,
  yes: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;

  // 1. Confirmation gate (once for the whole run).
  await confirmDestructive({
    promptMessage: confirmMessage(ids.length),
    yes,
    dryRun: opts.dryRun === true,
  });

  // 2. Build the client only AFTER confirmation succeeded — a non-TTY-no-yes
  //    rejection should not pay the credential-resolution cost.
  const client = await buildClient(appConfig, env);

  if (ids.length === 1) {
    await runOneId(ids[0]!, opts, appConfig, client, /* lineIndex */ undefined);
    return;
  }

  const exitAcc = new ExitCodeAccumulator();
  for (let i = 0; i < ids.length; i += 1) {
    const projectId = ids[i]!;
    try {
      await runOneId(projectId, opts, appConfig, client, /* lineIndex */ undefined);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, projectId, mode, /* fromStdin */ false);
      exitAcc.observe(typed.exitCode);
    }
  }

  if (exitAcc.value !== 0) {
    const { drainDispatcher, exitDeferred } = await import('../../errors/handle.js');
    await drainDispatcher();
    await exitDeferred(exitAcc.value);
  }
}

/* ---------------------------------------------------------------------------
 *  Batch from --stdin (NDJSON)
 * ------------------------------------------------------------------------- */

async function runBatchFromStdin(
  opts: DeleteOpts,
  yes: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const exitAcc = new ExitCodeAccumulator();

  const stdinSource: NodeJS.ReadableStream = process.stdin;
  const allLines: string[] = [];
  for await (const line of iterateLines(stdinSource)) {
    allLines.push(line);
  }

  if (allLines.length === 0) {
    // Empty stdin → silent success exit 0 (matches R09/R11/R13).
    return;
  }

  // Confirm AFTER buffering so empty stdin never prompts.
  await confirmDestructive({
    promptMessage: confirmMessage(allLines.length),
    yes,
    dryRun: opts.dryRun === true,
  });

  // Lazy client construction — a stdin of all-bad lines never reaches
  // credential resolution.
  let lazyClient: HttpClient | undefined;
  const getClient = async (): Promise<HttpClient> => {
    if (lazyClient === undefined) {
      lazyClient = await buildClient(appConfig, env);
    }
    return lazyClient;
  };

  for (let i = 0; i < allLines.length; i += 1) {
    const line = allLines[i]!;
    const result = parseNdjsonLine(line, i, BatchLineSchema);
    if (!result.ok) {
      writeBatchError(result.error, i, /* projectIdMaybe */ null, mode, /* fromStdin */ true);
      exitAcc.observe(result.error.exitCode);
      continue;
    }
    const projectId = result.value.id;
    try {
      const client = await getClient();
      await runOneId(projectId, opts, appConfig, client, /* lineIndex */ i);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, projectId, mode, /* fromStdin */ true);
      exitAcc.observe(typed.exitCode);
    }
  }

  if (exitAcc.value !== 0) {
    const { drainDispatcher, exitDeferred } = await import('../../errors/handle.js');
    await drainDispatcher();
    await exitDeferred(exitAcc.value);
  }
}

/* ---------------------------------------------------------------------------
 *  Per-id flow — dry-run / DELETE / 404-idempotent
 *
 *  Spec 0043 §3.3. No pre-check GET (decision 1); the DELETE response is
 *  the source of truth.
 * ------------------------------------------------------------------------- */

async function runOneId(
  projectId: number,
  opts: DeleteOpts,
  appConfig: PartialAppConfig,
  client: HttpClient,
  lineIndex: number | undefined,
): Promise<void> {
  const mode = appConfig.output.mode;

  // ---- 1. Dry-run: skip the DELETE, emit envelope with `would`.
  if (opts.dryRun === true) {
    const data: ProjectsDeleteData = {
      project_id: projectId,
      current_state: 'deleted',
      already_in_target_state: false,
      would: {
        method: 'DELETE',
        path: projectDeletePath(projectId),
        body: {},
      },
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope: Envelope<ProjectsDeleteData> = {
      schema: SCHEMA,
      data,
      dry_run: true,
    };
    if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
    writeEnvelope(envelope, mode);
    return;
  }

  // ---- 2. Live DELETE.
  try {
    const result = await deleteProject(client, projectId, {
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });

    const data: ProjectsDeleteData = {
      project_id: projectId,
      current_state: 'deleted',
      already_in_target_state: false,
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope = buildEnvelope({
      schema: SCHEMA,
      data,
      rateLimit: {
        remaining: result.raw.rateLimit.remaining,
        reset_at: result.raw.rateLimit.resetAt,
      },
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    writeEnvelope(envelope, mode);
    return;
  } catch (err: unknown) {
    // ---- 3. 404 → idempotent already-deleted (decision 4 / mirrors R13
    //         spec 0024 decision 3). Re-emit as success envelope.
    //         Calibration §4: this catch arm has dedicated test coverage.
    if (err instanceof FreeloApiError && err.code === 'NOT_FOUND') {
      const data: ProjectsDeleteData = {
        project_id: projectId,
        current_state: 'deleted',
        already_in_target_state: true,
        ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
      };
      const envelope = buildEnvelope({
        schema: SCHEMA,
        data,
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      writeEnvelope(envelope, mode);
      return;
    }
    // Any other error: bubble (single-mode → top-level handler;
    // multi-id / stdin batch → per-line writer).
    throw err;
  }
}

/* ---------------------------------------------------------------------------
 *  Helpers
 * ------------------------------------------------------------------------- */

async function buildClient(
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<HttpClient> {
  const creds = await resolveCredentials({
    profile: appConfig.profile,
    apiBaseUrl: appConfig.apiBaseUrl,
    env,
  });
  return createHttpClient({
    email: creds.email,
    apiKey: creds.apiKey,
    apiBaseUrl: creds.apiBaseUrl,
    userAgent: appConfig.userAgent,
  });
}

/**
 * Build the prompt copy for the confirmation gate (spec 0043 decision 6).
 * Project delete is reversible (`projects activate` undeletes), so the prompt
 * mentions soft-delete + the restore path. Calibration §7: tests asserting
 * this copy MUST clear `process.env['CI']`.
 */
function confirmMessage(count: number): string {
  const subject = count === 1 ? '1 project' : `${count} projects`;
  return `Delete ${subject}? This is a soft-delete; restore via 'freelo projects activate'.`;
}

function writeEnvelope(
  envelope: Envelope<ProjectsDeleteData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const line = renderProjectsDeleteHuman(envelope.data);
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function writeBatchError(
  err: BaseError,
  index: number,
  projectIdMaybe: number | null,
  mode: 'human' | 'json' | 'ndjson',
  fromStdin: boolean,
): void {
  if (mode === 'human') {
    const idPart = projectIdMaybe === null ? '' : ` (project #${projectIdMaybe})`;
    process.stdout.write(`Failed item ${index + 1}${idPart}: ${err.message}\n`);
    return;
  }
  const httpStatus =
    'httpStatus' in err && typeof err.httpStatus === 'number' ? err.httpStatus : null;
  const requestId = 'requestId' in err && typeof err.requestId === 'string' ? err.requestId : null;
  const errors =
    'errors' in err && Array.isArray((err as { errors?: unknown }).errors)
      ? (err as { errors: string[] }).errors
      : undefined;
  const context: Record<string, number> = fromStdin
    ? { line_index: index }
    : { input_index: index };
  if (projectIdMaybe !== null) context['project_id'] = projectIdMaybe;
  const envelope = {
    schema: 'freelo.error/v1' as const,
    error: {
      code: err.code,
      message: err.message,
      ...(errors !== undefined && errors.length > 0 ? { errors } : {}),
      http_status: httpStatus,
      request_id: requestId,
      retryable: err.retryable,
      hint_next: err.hintNext ?? null,
      docs_url: null,
      context,
    },
  };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Coerce an unknown thrown value into a `BaseError`. Mirrors R11/R13.
 * Calibration §4: this is one of the new try/catch arms; covered by tests.
 */
function toBaseError(err: unknown): BaseError {
  if (err instanceof BaseError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ValidationError(message, {
    hintNext: 'Investigate the underlying error and retry the id.',
  });
}
