/**
 * `freelo reports log --task <id> --minutes <n> [--date YYYY-MM-DD] [--note <str>] [--dry-run] [--stdin]`
 * (R22, spec 0034).
 *
 * Logs a finalized work report directly on a task — bypasses the live timer
 * flow. Useful for retroactive timesheet entry.
 *
 * Maps to `POST /task/{task_id}/work-reports` (yaml :3045-3093).
 *
 * Single-mode flags (`--task`, `--minutes`, `--date`, `--note`) are mutex
 * with `--stdin`. NDJSON rows: `{ task: int, minutes: int, date?: "YYYY-MM-DD", note?: string }`.
 *
 * No `--cost` / `--worker` / `--ids` in v1 (spec 0034 §3.2 / decision 03).
 *
 * Output schema: `freelo.reports.log/v1`.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  buildCreateReportBody,
  createReport,
  createReportPath,
  type CreateReportInput,
  type CreateReportResult,
} from '../../api/reports.js';
import {
  projectReport,
  type ReportsLogAppliedInput,
  type ReportsLogLiveData,
  type ReportsLogDryRunData,
} from '../../api/schemas/report.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { render } from '../../ui/render.js';
import { renderReportsLogHuman } from '../../ui/human/reports-log.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.reports.log/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.reports.log/v1';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type LogOpts = {
  task?: number;
  minutes?: number;
  date?: string;
  note?: string;
  dryRun?: boolean;
  stdin?: boolean;
};

/**
 * Per-line NDJSON shape for `--stdin` batch mode. Mirrors the long-form CLI
 * flags with kebab→snake conversion (and the natural `task` / `minutes`
 * shorthand). Unknown keys fail via `.strict()`.
 *
 * Numeric refinements match the single-mode parsers (positive integers).
 */
const BatchLineSchema = z
  .object({
    task: z
      .number()
      .int("'task' must be an integer (no string-form).")
      .positive("'task' must be ≥ 1."),
    minutes: z
      .number()
      .int("'minutes' must be an integer (no string-form).")
      .positive("'minutes' must be ≥ 1."),
    date: z.string().regex(ISO_DATE, "'date' must be in YYYY-MM-DD format").optional(),
    note: z.string().optional(),
  })
  .strict();

type BatchLine = z.infer<typeof BatchLineSchema>;

/* ---------------------------------------------------------------------------
 *  Input parsers
 * ------------------------------------------------------------------------- */

function parsePositiveIntFlag(label: string, hint: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`${label} must be a positive integer.`, { hintNext: hint });
  }
  return n;
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

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerLog(
  reports: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = reports
    .command('log')
    .description(
      'Log a finalized work report on a task (bypasses the live-timer flow). Single-mode (--task / --minutes …) or NDJSON batch via --stdin.',
    )
    .option('--task <id>', 'Numeric task id to log time against (single-mode).', (raw) =>
      parsePositiveIntFlag(
        '--task',
        '--task is the numeric task id from `freelo tasks list`.',
        raw,
      ),
    )
    .option('--minutes <n>', 'Duration in whole minutes (single-mode).', (raw) =>
      parsePositiveIntFlag('--minutes', '--minutes is a positive integer (whole minutes).', raw),
    )
    .option(
      '--date <date>',
      'Backdate the report (YYYY-MM-DD). Defaults to server "today".',
      (raw) => parseDateFlag('--date', raw),
    )
    .option('--note <str>', 'Free-form note attached to the report. Empty string accepted.')
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.')
    .option(
      '--stdin',
      'Read NDJSON from stdin (one `{"task": <int>, "minutes": <int>, "date"?: "YYYY-MM-DD", "note"?: string}` per line). Mutex with single-mode flags.',
    );
  attachMeta(cmd, meta);

  cmd.action(async (opts: LogOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      validateInputSources(opts);

      if (opts.stdin === true) {
        await runBatchFromStdin(opts, appConfig, env);
        return;
      }

      // Single-mode: --task and --minutes are required.
      if (opts.task === undefined) {
        throw new ValidationError('--task is required (or use --stdin for batch input).', {
          hintNext: '--task is the numeric task id from `freelo tasks list`.',
        });
      }
      if (opts.minutes === undefined) {
        throw new ValidationError('--minutes is required (or use --stdin for batch input).', {
          hintNext: '--minutes is a positive integer (whole minutes).',
        });
      }

      await runSingle(
        {
          task: opts.task,
          minutes: opts.minutes,
          ...(opts.date !== undefined ? { date: opts.date } : {}),
          ...(opts.note !== undefined ? { note: opts.note } : {}),
        },
        opts.dryRun === true,
        appConfig,
        env,
      );
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Cross-source validation (mutex check between single-mode and --stdin)
 * ------------------------------------------------------------------------- */

function validateInputSources(opts: LogOpts): void {
  const hasSingleModeFlag =
    opts.task !== undefined ||
    opts.minutes !== undefined ||
    opts.date !== undefined ||
    opts.note !== undefined;
  const hasStdin = opts.stdin === true;
  if (hasSingleModeFlag && hasStdin) {
    throw new ValidationError(
      'Single-mode flags (--task / --minutes / --date / --note) are mutex with --stdin.',
      {
        hintNext: 'Pick one input source: single-mode flags, or NDJSON via --stdin.',
      },
    );
  }
}

/* ---------------------------------------------------------------------------
 *  Single-mode flow
 * ------------------------------------------------------------------------- */

type SingleInput = {
  task: number;
  minutes: number;
  date?: string;
  note?: string;
};

async function runSingle(
  input: SingleInput,
  dryRun: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;

  const apiInput: CreateReportInput = {
    minutes: input.minutes,
    ...(input.date !== undefined ? { dateReported: input.date } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
  const body = buildCreateReportBody(apiInput);

  const appliedInput: ReportsLogAppliedInput = {
    task_id: input.task,
    minutes: input.minutes,
    ...(input.date !== undefined ? { date_reported: input.date } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
  };

  // ---- Dry-run: skip the POST and credential resolution.
  if (dryRun) {
    const dryData: ReportsLogDryRunData = { applied_input: appliedInput };
    const envelope = dryRunEnvelope({
      schema: SCHEMA,
      data: dryData,
      would: { method: 'POST', path: createReportPath(input.task), body },
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    render(mode, envelope, (d) => renderReportsLogHuman(d));
    return;
  }

  // ---- Live POST.
  const client = await buildClient(appConfig, env);
  const result = await createReport(client, input.task, {
    body,
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });

  emitLiveEnvelope(result, appliedInput, undefined, appConfig);
}

/* ---------------------------------------------------------------------------
 *  Batch flow — `--stdin` (NDJSON)
 *
 *  Mirrors `tasks/create.ts --stdin` and `tasks/delete.ts --stdin`: buffer
 *  stdin, parse each line, then dispatch per-line. Continue-on-error: a bad
 *  row emits a `freelo.error/v1` envelope on stdout and the highest-of exit
 *  code wins at end-of-loop.
 * ------------------------------------------------------------------------- */

async function runBatchFromStdin(
  opts: LogOpts,
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
    // Empty stdin → silent success exit 0 (matches tasks/create / tasks/delete).
    return;
  }

  // Lazy client construction — a stdin of all-bad lines never resolves credentials.
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
      writeBatchError(result.error, i, /* taskIdMaybe */ null, mode);
      exitAcc.observe(result.error.exitCode);
      continue;
    }
    const row: BatchLine = result.value;
    try {
      await runOneBatchLine(row, i, opts.dryRun === true, appConfig, getClient);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, row.task, mode);
      exitAcc.observe(typed.exitCode);
    }
  }

  if (exitAcc.value !== 0) {
    const { drainDispatcher, exitDeferred } = await import('../../errors/handle.js');
    await drainDispatcher();
    await exitDeferred(exitAcc.value);
  }
}

async function runOneBatchLine(
  row: BatchLine,
  lineIndex: number,
  dryRun: boolean,
  appConfig: PartialAppConfig,
  getClient: () => Promise<HttpClient>,
): Promise<void> {
  const mode = appConfig.output.mode;

  const apiInput: CreateReportInput = {
    minutes: row.minutes,
    ...(row.date !== undefined ? { dateReported: row.date } : {}),
    ...(row.note !== undefined ? { note: row.note } : {}),
  };
  const body = buildCreateReportBody(apiInput);

  const appliedInput: ReportsLogAppliedInput = {
    task_id: row.task,
    minutes: row.minutes,
    ...(row.date !== undefined ? { date_reported: row.date } : {}),
    ...(row.note !== undefined ? { note: row.note } : {}),
  };

  if (dryRun) {
    const dryData: ReportsLogDryRunData = { applied_input: appliedInput, line_index: lineIndex };
    const envelope = dryRunEnvelope({
      schema: SCHEMA,
      data: dryData,
      would: { method: 'POST', path: createReportPath(row.task), body },
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    render(mode, envelope, (d) => renderReportsLogHuman(d));
    return;
  }

  const client = await getClient();
  const result = await createReport(client, row.task, {
    body,
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });

  emitLiveEnvelope(result, appliedInput, lineIndex, appConfig);
}

/* ---------------------------------------------------------------------------
 *  Helpers
 * ------------------------------------------------------------------------- */

function emitLiveEnvelope(
  result: CreateReportResult,
  appliedInput: ReportsLogAppliedInput,
  lineIndex: number | undefined,
  appConfig: PartialAppConfig,
): void {
  const mode = appConfig.output.mode;
  const data: ReportsLogLiveData = {
    report: projectReport(result.report),
    applied_input: appliedInput,
    ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
  };
  const envelope: Envelope<ReportsLogLiveData> = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: result.raw.rateLimit.remaining,
      reset_at: result.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  render(mode, envelope, (d) => renderReportsLogHuman(d));
}

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

function writeBatchError(
  err: BaseError,
  index: number,
  taskIdMaybe: number | null,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const idPart = taskIdMaybe === null ? '' : ` (task #${taskIdMaybe})`;
    process.stdout.write(`Failed line ${index + 1}${idPart}: ${err.message}\n`);
    return;
  }
  const httpStatus =
    'httpStatus' in err && typeof err.httpStatus === 'number' ? err.httpStatus : null;
  const requestId = 'requestId' in err && typeof err.requestId === 'string' ? err.requestId : null;
  const errors =
    'errors' in err && Array.isArray((err as { errors?: unknown }).errors)
      ? (err as { errors: string[] }).errors
      : undefined;
  const context: Record<string, number> = { line_index: index };
  if (taskIdMaybe !== null) context['task_id'] = taskIdMaybe;
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
    hintNext: 'Investigate the underlying error and retry the line.',
  });
}
