/**
 * Shared command logic for `freelo projects archive` and
 * `freelo projects activate` (R30, spec 0043).
 *
 * Both commands have identical CLI surfaces (variadic `<id>...` plus `--ids`
 * plus `--stdin` plus `--dry-run`) and identical batch flow — only the verb
 * (and therefore the wire endpoint, the schema discriminant, and the
 * resulting `current_state`) differ. This module owns the orchestration; the
 * leaf `archive.ts` / `activate.ts` files only re-export the registrar.
 *
 * **Differences from `tasks/transition.ts` (R11):**
 *   - **No GET pre-check** (spec 0043 decision 1). Server-side idempotency is
 *     documented (yaml :635 for archive, :662 for activate), so a redundant
 *     client GET buys nothing. Without a pre-check, `previous_state` and
 *     `already_in_target_state` are unobservable; the envelope omits them
 *     (decision 5). Agents that need previous state call
 *     `freelo projects show` first.
 *   - **No idempotency helper call** for the same reason. `current_state`
 *     is set to the verb's target literal post-POST.
 *
 * Spec 0043 §3.4 / §3.5.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  archiveProject,
  activateProject,
  projectsTransitionPath,
  type ProjectsTransitionVerb,
} from '../../api/projects-transition.js';
import { type ProjectsTransitionData } from '../../api/schemas/project.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import {
  renderProjectsTransitionHuman,
  renderProjectsBatchItemFailureHuman,
} from '../../ui/human/projects-transition.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

/* ---------------------------------------------------------------------------
 *  Public types
 * ------------------------------------------------------------------------- */

export type TransitionOpts = {
  ids?: string;
  stdin?: true;
  dryRun?: true;
};

/** Per-verb wiring (schema + target state + name) — locked at register time. */
type VerbWiring = {
  verb: ProjectsTransitionVerb;
  cliName: 'archive' | 'activate';
  /** Schema discriminant for the success envelope. */
  schema: SchemaString;
  /** Target state on the wire (the verb's documented post-condition). */
  targetState: 'archived' | 'active';
  /** Description used in command help. */
  description: string;
};

const ARCHIVE: VerbWiring = {
  verb: 'archive',
  cliName: 'archive',
  schema: 'freelo.projects.archive/v1',
  targetState: 'archived',
  description:
    'Archive one or more projects. Idempotent on the server: re-archiving an already-archived project succeeds (200 no-op).',
};

const ACTIVATE: VerbWiring = {
  verb: 'activate',
  cliName: 'activate',
  schema: 'freelo.projects.activate/v1',
  targetState: 'active',
  description:
    'Activate (unarchive or undelete) one or more projects. Idempotent on the server: already-active projects return 200 no-op. May fail with PlanExceededException when restoring exceeds the plan cap.',
};

/* ---------------------------------------------------------------------------
 *  Input parsing
 * ------------------------------------------------------------------------- */

/**
 * Parse a positive integer from a CLI string. Throws `ValidationError` (exit
 * 2) — NOT Commander's `InvalidArgumentError` (calibration §1-2).
 */
function parsePositiveInt(label: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`${label} must be a positive integer.`, {
      hintNext: `${label} is the numeric project id from \`freelo projects list\`.`,
    });
  }
  return n;
}

/**
 * Variadic `<id>...` collector. Each token is parsed eagerly so a bad id
 * surfaces as `ValidationError` at parse time.
 */
function collectProjectId(raw: string, prev: number[] | undefined): number[] {
  const n = parsePositiveInt('<id>', raw);
  return prev ? [...prev, n] : [n];
}

/**
 * Parse `--ids "a, b, c"` into a list of positive integers. Splits on commas
 * AND whitespace. Empty result → `ValidationError`.
 */
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
 *  Per-line NDJSON schema (--stdin batch mode)
 * ------------------------------------------------------------------------- */

const BatchLineSchema = z
  .object({
    id: z.number().int('id must be an integer (no string-form).').positive('id must be ≥ 1.'),
  })
  .strict();

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

/** Register `projects archive`. Wired via `src/commands/projects.ts`. */
export function registerArchive(
  projects: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  registerTransition(projects, getConfig, env, ARCHIVE);
}

/** Register `projects activate`. Wired via `src/commands/projects.ts`. */
export function registerActivate(
  projects: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  registerTransition(projects, getConfig, env, ACTIVATE);
}

function registerTransition(
  projects: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
  wiring: VerbWiring,
): void {
  const meta: CommandMeta = {
    outputSchema: wiring.schema,
    destructive: false,
  };

  const cmd = projects
    .command(wiring.cliName)
    .description(wiring.description)
    .argument('[id...]', 'One or more numeric project ids (positional).', collectProjectId)
    .option(
      '--ids <list>',
      'Comma- or space-separated list of project ids (mutex with positional <id> and --stdin).',
    )
    .option(
      '--stdin',
      'Read NDJSON from stdin (one `{"id": <int>}` per line). Mutex with positional and --ids.',
    )
    .option('--dry-run', 'Skip the POST per id. Envelope reflects the call that would have run.');
  attachMeta(cmd, meta);

  cmd.action(async (ids: number[] | undefined, opts: TransitionOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      validateInputSources(ids, opts);

      if (opts.stdin === true) {
        await runBatchFromStdin(opts, appConfig, env, wiring);
        return;
      }

      const resolvedIds =
        ids !== undefined && ids.length > 0
          ? ids
          : opts.ids !== undefined
            ? parseIdsFlag(opts.ids)
            : [];

      if (resolvedIds.length === 0) {
        // No ids resolved from any source → silent success exit 0
        // (matches R09/R11/R13 batch convention).
        return;
      }
      await runIdList(resolvedIds, opts, appConfig, env, wiring, /* fromStdin */ false);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Cross-source validation
 * ------------------------------------------------------------------------- */

function validateInputSources(ids: number[] | undefined, opts: TransitionOpts): void {
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
}

/* ---------------------------------------------------------------------------
 *  Batch from --stdin (NDJSON)
 * ------------------------------------------------------------------------- */

async function runBatchFromStdin(
  opts: TransitionOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
  wiring: VerbWiring,
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

  // Lazy client construction — a stdin of all-bad lines never reaches
  // credential resolution.
  let lazyClient: HttpClient | undefined;
  const getClient = async (): Promise<HttpClient> => {
    if (lazyClient === undefined) {
      lazyClient = await buildClient(appConfig, env);
    }
    return lazyClient;
  };

  // Process lines in input order so the NDJSON output stream's order matches
  // stdin (R11 fix, spec 0021 §3.5).
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
      await runOneId(projectId, opts, appConfig, wiring, client, i, /* fromStdin */ true);
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
 *  Batch from positional / --ids
 * ------------------------------------------------------------------------- */

async function runIdList(
  ids: readonly number[],
  opts: TransitionOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
  wiring: VerbWiring,
  fromStdin: boolean,
): Promise<void> {
  const mode = appConfig.output.mode;

  // Single-id mode: errors bubble up to the top-level handler. Multi-id
  // mode: per-id error envelopes go to stdout (the success path's stream)
  // and the highest exit code wins at end-of-loop. Same shape as R11 / R13.
  // For dry-run we never need a client, so build it lazily for the live POST.
  let lazyClient: HttpClient | undefined;
  const getClient = async (): Promise<HttpClient> => {
    if (lazyClient === undefined) {
      lazyClient = await buildClient(appConfig, env);
    }
    return lazyClient;
  };

  if (ids.length === 1) {
    const id = ids[0]!;
    if (opts.dryRun === true) {
      emitDryRun(id, undefined, wiring, appConfig, mode);
      return;
    }
    const client = await getClient();
    await runOneId(id, opts, appConfig, wiring, client, undefined, fromStdin);
    return;
  }

  const exitAcc = new ExitCodeAccumulator();
  for (let i = 0; i < ids.length; i += 1) {
    const projectId = ids[i]!;
    try {
      if (opts.dryRun === true) {
        emitDryRun(projectId, undefined, wiring, appConfig, mode);
        continue;
      }
      const client = await getClient();
      await runOneId(projectId, opts, appConfig, wiring, client, undefined, fromStdin);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, projectId, mode, fromStdin);
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
 *  Per-id flow (live POST or dry-run echo)
 * ------------------------------------------------------------------------- */

async function runOneId(
  projectId: number,
  opts: TransitionOpts,
  appConfig: PartialAppConfig,
  wiring: VerbWiring,
  client: HttpClient,
  lineIndex: number | undefined,
  fromStdin: boolean,
): Promise<void> {
  const mode = appConfig.output.mode;

  // Dry-run path: skip the POST, emit envelope with `would`. (Spec 0043
  // decision 1 — no GET pre-check, so no `previous_state` to surface.)
  if (opts.dryRun === true) {
    emitDryRun(projectId, fromStdin ? lineIndex : undefined, wiring, appConfig, mode);
    return;
  }

  // Live POST.
  const result =
    wiring.verb === 'archive'
      ? await archiveProject(client, projectId, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        })
      : await activateProject(client, projectId, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });

  // Build the success envelope. `current_state` is the verb's target literal
  // (decision 3): the OpenAPI documents server-side idempotency, so 200
  // means the project is in the target state regardless of the prior one.
  const data: ProjectsTransitionData = {
    project_id: projectId,
    current_state: wiring.targetState,
    ...(fromStdin && lineIndex !== undefined ? { line_index: lineIndex } : {}),
  };
  const envelope = buildEnvelope({
    schema: wiring.schema,
    data,
    rateLimit: {
      remaining: result.raw.rateLimit.remaining,
      reset_at: result.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  writeEnvelope(envelope, mode);
}

/**
 * Build and emit a `--dry-run` envelope. Pulled out of `runOneId` so the
 * single-mode and multi-mode dispatchers can both call it without paying
 * the credential / client construction cost.
 */
function emitDryRun(
  projectId: number,
  lineIndex: number | undefined,
  wiring: VerbWiring,
  appConfig: PartialAppConfig,
  mode: 'human' | 'json' | 'ndjson',
): void {
  const data: ProjectsTransitionData = {
    project_id: projectId,
    current_state: wiring.targetState,
    would: {
      method: 'POST',
      path: projectsTransitionPath(wiring.verb, projectId),
      body: {},
    },
    ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
  };
  const envelope: Envelope<ProjectsTransitionData> = {
    schema: wiring.schema,
    data,
    dry_run: true,
  };
  if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
  writeEnvelope(envelope, mode);
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

function writeEnvelope(
  envelope: Envelope<ProjectsTransitionData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const line = renderProjectsTransitionHuman(envelope.data);
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Per-id error envelope writer for batch mode. Mirrors R11/R13 shape:
 * `freelo.error/v1` augmented with `context.line_index` (stdin) or
 * `context.input_index` (positional / --ids), plus `context.project_id` when
 * a line parsed.
 *
 * Calibration §4: this is one of the new try/catch arms; covered by tests.
 */
function writeBatchError(
  err: BaseError,
  index: number,
  projectIdMaybe: number | null,
  mode: 'human' | 'json' | 'ndjson',
  fromStdin: boolean,
): void {
  if (mode === 'human') {
    process.stdout.write(
      `${renderProjectsBatchItemFailureHuman(index, projectIdMaybe, err.message)}\n`,
    );
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
 * Coerce an unknown thrown value into a `BaseError`. Mirrors R11/R13 — the
 * per-id catch in batch loops calls this so any throw that isn't already a
 * `BaseError` (defensive: should not happen in normal flow) maps to a
 * `VALIDATION_ERROR` (exit 2) with a sensible message.
 *
 * Calibration §4: this is one of the new try/catch arms; covered by tests.
 */
function toBaseError(err: unknown): BaseError {
  if (err instanceof BaseError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ValidationError(message, {
    hintNext: 'Investigate the underlying error and retry the id.',
  });
}
