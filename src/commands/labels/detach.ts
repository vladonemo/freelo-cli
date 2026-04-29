/**
 * `freelo labels detach --project <id> --label <id>... [--ids <list>] [--stdin] [--dry-run]`
 * (R23, spec 0035).
 *
 * Detach one or more labels from a project. Each `--label` fans out to one
 * POST. Idempotent on 404 — if the label isn't currently attached the
 * envelope reports `already_in_target_state: true` with exit 0
 * (decision 09 — two-arm heuristic, no documented 400 fallback).
 *
 * Maps to **`POST /project-labels/remove-from-project/{projectId}`** (verb is
 * POST, not DELETE — spec 0035 decision 02).
 *
 * Body shape: id-mode `{ id: number }` only. Data-mode (by name) is not
 * surfaced in v1 (out of scope per spec §8 non-goals — name lookup would be
 * ambiguous when caller has multiple labels with the same name in different
 * is-private states).
 *
 * Not destructive at the workspace level (the label is preserved; it can
 * always be re-attached). No `--yes` and no confirmation prompt.
 *
 * Output schema: `freelo.labels.detach/v1`.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  buildDetachProjectLabelBody,
  detachLabelFromProject,
  detachLabelPath,
} from '../../api/project-labels.js';
import { type LabelsDetachData } from '../../api/schemas/project-label.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderLabelsDetachHuman } from '../../ui/human/labels-detach.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.labels.detach/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.labels.detach/v1';

type DetachOpts = {
  project?: number;
  label?: number[];
  ids?: string;
  stdin?: true;
  dryRun?: true;
};

/* ---------------------------------------------------------------------------
 *  Per-line NDJSON schema. Accepts both `{ label }` and `{ id }` per spec.
 * ------------------------------------------------------------------------- */

const BatchLineSchema = z
  .object({
    label: z.number().int().positive().optional(),
    id: z.number().int().positive().optional(),
  })
  .strict()
  .refine((v) => v.label !== undefined || v.id !== undefined, {
    message: "row must contain 'label' or 'id'.",
  });

/* ---------------------------------------------------------------------------
 *  Input parsing
 * ------------------------------------------------------------------------- */

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
  return parsePositiveInt('--project', raw);
}

function collectLabelId(raw: string, prev: number[] | undefined): number[] {
  const n = parsePositiveInt('--label', raw);
  return prev ? [...prev, n] : [n];
}

function parseIdsFlag(raw: string): number[] {
  const tokens = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) {
    throw new ValidationError('--ids requires at least one id.', {
      hintNext: '--ids takes a comma- or space-separated list of numeric label ids.',
    });
  }
  return tokens.map((t) => parsePositiveInt('--ids', t));
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerDetach(
  labels: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = labels
    .command('detach')
    .description(
      'Detach one or more labels from a project. Idempotent — detaching a label that is not attached is a successful no-op (404 → already_in_target_state: true).',
    )
    .requiredOption(
      '--project <id>',
      'Numeric project id (the project to detach from).',
      parseProjectIdFlag,
    )
    .option(
      '--label <id>',
      'Numeric label id (repeatable). Mutex with --ids and --stdin.',
      collectLabelId,
    )
    .option(
      '--ids <list>',
      'Comma- or space-separated list of label ids (mutex with --label and --stdin).',
    )
    .option(
      '--stdin',
      'Read NDJSON from stdin (one `{"label": <int>}` per line; `{"id": <int>}` also accepted). Mutex with --label and --ids.',
    )
    .option('--dry-run', 'Skip every POST; envelope echoes one `would` per id.');
  attachMeta(cmd, meta);

  cmd.action(async (opts: DetachOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      validateInputSources(opts);

      const projectId = opts.project!;

      if (opts.stdin === true) {
        await runBatchFromStdin(projectId, opts, appConfig, env);
        return;
      }

      const resolvedIds =
        opts.label !== undefined && opts.label.length > 0
          ? opts.label
          : opts.ids !== undefined
            ? parseIdsFlag(opts.ids)
            : [];

      if (resolvedIds.length === 0) {
        // No ids resolved → silent success (matches reports/delete pattern).
        return;
      }

      await runIdList(projectId, resolvedIds, opts, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Cross-source validation
 * ------------------------------------------------------------------------- */

function validateInputSources(opts: DetachOpts): void {
  const hasLabel = opts.label !== undefined && opts.label.length > 0;
  const hasIdsFlag = opts.ids !== undefined && opts.ids.trim().length > 0;
  const hasStdin = opts.stdin === true;
  const sourceCount = (hasLabel ? 1 : 0) + (hasIdsFlag ? 1 : 0) + (hasStdin ? 1 : 0);
  if (sourceCount > 1) {
    throw new ValidationError(
      'Pick exactly one input source: --label (repeatable), --ids, or --stdin.',
      {
        hintNext: 'Combining input sources is ambiguous — agents should pre-resolve to one shape.',
      },
    );
  }
  if (sourceCount === 0) {
    throw new ValidationError('No label ids supplied.', {
      hintNext: 'Pass --label <id> (repeatable), or --ids "a,b,c", or pipe NDJSON to --stdin.',
    });
  }
}

/* ---------------------------------------------------------------------------
 *  Batch from --label / --ids
 * ------------------------------------------------------------------------- */

async function runIdList(
  projectId: number,
  ids: readonly number[],
  opts: DetachOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const client = await buildClient(appConfig, env);

  if (ids.length === 1) {
    await runOneId(projectId, ids[0]!, opts, appConfig, client, /* lineIndex */ undefined);
    return;
  }

  const exitAcc = new ExitCodeAccumulator();
  for (let i = 0; i < ids.length; i += 1) {
    const labelId = ids[i]!;
    try {
      await runOneId(projectId, labelId, opts, appConfig, client, /* lineIndex */ undefined);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, projectId, labelId, mode, /* fromStdin */ false);
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
  projectId: number,
  opts: DetachOpts,
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
    return;
  }

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
      writeBatchError(result.error, i, projectId, /* idMaybe */ null, mode, /* fromStdin */ true);
      exitAcc.observe(result.error.exitCode);
      continue;
    }
    const labelId = result.value.label ?? result.value.id!;
    try {
      const client = await getClient();
      await runOneId(projectId, labelId, opts, appConfig, client, /* lineIndex */ i);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, projectId, labelId, mode, /* fromStdin */ true);
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
 *  Per-id flow — dry-run / POST / two-arm idempotency
 * ------------------------------------------------------------------------- */

async function runOneId(
  projectId: number,
  labelId: number,
  opts: DetachOpts,
  appConfig: PartialAppConfig,
  client: HttpClient,
  lineIndex: number | undefined,
): Promise<void> {
  const mode = appConfig.output.mode;
  const body = buildDetachProjectLabelBody(labelId);

  // ---- 1. Dry-run.
  if (opts.dryRun === true) {
    const data: LabelsDetachData = {
      project_id: projectId,
      label_id: labelId,
      previous_state: null,
      current_state: 'detached',
      already_in_target_state: false,
      would: {
        method: 'POST',
        path: detachLabelPath(projectId),
        body,
      },
      ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
    };
    const envelope: Envelope<LabelsDetachData> = {
      schema: SCHEMA,
      data,
      dry_run: true,
    };
    if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
    writeEnvelope(envelope, mode);
    return;
  }

  // ---- 2. Live POST.
  try {
    const result = await detachLabelFromProject(client, projectId, {
      body,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });

    const data: LabelsDetachData = {
      project_id: projectId,
      label_id: labelId,
      previous_state: null,
      current_state: 'detached',
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
    // ---- 3. Two-arm idempotency heuristic (decision 09).
    if (err instanceof FreeloApiError && isIdempotentDetachSkip(err)) {
      const data: LabelsDetachData = {
        project_id: projectId,
        label_id: labelId,
        previous_state: null,
        current_state: 'detached',
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
    // Other errors bubble.
    throw err;
  }
}

/**
 * Decide whether a `FreeloApiError` represents a detach on a label that's
 * not attached to the project (idempotent skip) vs. a real failure. Two-arm
 * matrix per spec 0035 decision 09:
 *
 *   1. HTTP 404 → idempotent skip.
 *   2. Otherwise → NOT idempotent.
 *
 * Exported for direct unit-test coverage of the matrix without the full
 * end-to-end harness.
 */
export function isIdempotentDetachSkip(err: FreeloApiError): boolean {
  return err.httpStatus === 404;
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
  envelope: Envelope<LabelsDetachData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const line = renderLabelsDetachHuman(envelope.data);
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function writeBatchError(
  err: BaseError,
  index: number,
  projectId: number,
  idMaybe: number | null,
  mode: 'human' | 'json' | 'ndjson',
  fromStdin: boolean,
): void {
  if (mode === 'human') {
    const idPart = idMaybe === null ? '' : ` (label #${idMaybe})`;
    process.stdout.write(
      `Failed item ${index + 1}${idPart} (project #${projectId}): ${err.message}\n`,
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
    ? { line_index: index, project_id: projectId }
    : { input_index: index, project_id: projectId };
  if (idMaybe !== null) context['label_id'] = idMaybe;
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

function toBaseError(err: unknown): BaseError {
  if (err instanceof BaseError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ValidationError(message, {
    hintNext: 'Investigate the underlying error and retry the id.',
  });
}
