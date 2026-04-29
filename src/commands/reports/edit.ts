/**
 * `freelo reports edit <id> [--minutes <n>] [--note <str>] [--date YYYY-MM-DD] [--dry-run] [--stdin]`
 * (R22, spec 0034).
 *
 * Edits an existing work report. At least one of `--minutes` / `--note` /
 * `--date` is required (empty edit rejected).
 *
 * Maps to **`POST /work-reports/{id}`** (verb is POST, not PATCH — see spec
 * 0034 decision 01; prior precedent R18 / R20).
 *
 * Single-mode positional `<id>` plus change flags is mutex with `--stdin`.
 * NDJSON rows: `{ id: int, minutes?: int, note?: string, date?: "YYYY-MM-DD" }`.
 *
 * No `--task` (re-parent) or `--cost` flags in v1 (spec 0034 §3.3).
 *
 * Output schema: `freelo.reports.edit/v1`.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  buildEditReportBody,
  editReport,
  reportPath,
  type EditReportInput,
  type EditReportResult,
} from '../../api/reports.js';
import {
  projectReport,
  type ReportsEditAppliedChanges,
  type ReportsEditDryRunData,
  type ReportsEditLiveData,
} from '../../api/schemas/report.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { render } from '../../ui/render.js';
import { renderReportsEditHuman } from '../../ui/human/reports-edit.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.reports.edit/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.reports.edit/v1';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type EditOpts = {
  minutes?: number;
  note?: string;
  date?: string;
  dryRun?: boolean;
  stdin?: boolean;
};

/**
 * Per-line NDJSON shape. `id` is required; at least one of `minutes` /
 * `note` / `date` must be present (validated below at the row-dispatch
 * stage so we can emit a precise per-line message).
 */
const BatchLineSchema = z
  .object({
    id: z.number().int("'id' must be an integer (no string-form).").positive("'id' must be ≥ 1."),
    minutes: z.number().int().positive("'minutes' must be ≥ 1.").optional(),
    note: z.string().optional(),
    date: z.string().regex(ISO_DATE, "'date' must be in YYYY-MM-DD format").optional(),
  })
  .strict();

type BatchLine = z.infer<typeof BatchLineSchema>;

/* ---------------------------------------------------------------------------
 *  Input parsers
 * ------------------------------------------------------------------------- */

function parseTaskId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('<id> must be a positive integer.', {
      hintNext: '<id> is the numeric report id from `freelo reports list`.',
    });
  }
  return n;
}

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

export function registerEdit(
  reports: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = reports
    .command('edit')
    .description(
      'Edit an existing work report (minutes / note / date). At least one change flag is required. Single-mode (<id> + flags) or NDJSON batch via --stdin.',
    )
    .argument('[id]', 'Numeric work-report id (positional, single-mode).', parseTaskId)
    .option('--minutes <n>', 'New duration in whole minutes.', (raw) =>
      parsePositiveIntFlag('--minutes', '--minutes is a positive integer (whole minutes).', raw),
    )
    .option('--note <str>', 'New note. Empty string accepted.')
    .option('--date <date>', 'New date_reported (YYYY-MM-DD).', (raw) =>
      parseDateFlag('--date', raw),
    )
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.')
    .option(
      '--stdin',
      'Read NDJSON from stdin (one `{"id": <int>, "minutes"?: <int>, "note"?: string, "date"?: "YYYY-MM-DD"}` per line). Mutex with positional <id>.',
    );
  attachMeta(cmd, meta);

  cmd.action(async (id: number | undefined, opts: EditOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      validateInputSources(id, opts);

      if (opts.stdin === true) {
        await runBatchFromStdin(opts, appConfig, env);
        return;
      }

      // Single-mode requires <id>.
      if (id === undefined) {
        throw new ValidationError('<id> is required (or use --stdin for batch input).', {
          hintNext: '<id> is the numeric report id from `freelo reports list`.',
        });
      }
      // Empty edit rejected.
      if (opts.minutes === undefined && opts.note === undefined && opts.date === undefined) {
        throw new ValidationError(
          '`reports edit` requires at least one of --minutes, --note, or --date.',
          {
            hintNext:
              'Pass at least one change flag: --minutes <n>, --note <str>, or --date YYYY-MM-DD.',
          },
        );
      }

      await runSingle(
        id,
        {
          ...(opts.minutes !== undefined ? { minutes: opts.minutes } : {}),
          ...(opts.note !== undefined ? { note: opts.note } : {}),
          ...(opts.date !== undefined ? { date: opts.date } : {}),
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
 *  Cross-source validation
 * ------------------------------------------------------------------------- */

function validateInputSources(id: number | undefined, opts: EditOpts): void {
  const hasPositional = id !== undefined;
  const hasSingleModeFlag =
    opts.minutes !== undefined || opts.note !== undefined || opts.date !== undefined;
  const hasStdin = opts.stdin === true;
  if ((hasPositional || hasSingleModeFlag) && hasStdin) {
    throw new ValidationError('Single-mode <id> / change flags are mutex with --stdin.', {
      hintNext: 'Pick one input source: <id> + flags, or NDJSON via --stdin.',
    });
  }
}

/* ---------------------------------------------------------------------------
 *  Single-mode flow
 * ------------------------------------------------------------------------- */

type SingleChanges = {
  minutes?: number;
  note?: string;
  date?: string;
};

async function runSingle(
  id: number,
  changes: SingleChanges,
  dryRun: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;

  const apiInput: EditReportInput = {
    ...(changes.minutes !== undefined ? { minutes: changes.minutes } : {}),
    ...(changes.date !== undefined ? { dateReported: changes.date } : {}),
    ...(changes.note !== undefined ? { note: changes.note } : {}),
  };
  const body = buildEditReportBody(apiInput);

  const appliedChanges: ReportsEditAppliedChanges = {};
  if (changes.minutes !== undefined) appliedChanges.minutes = changes.minutes;
  if (changes.note !== undefined) appliedChanges.note = changes.note;
  if (changes.date !== undefined) appliedChanges.date_reported = changes.date;

  // ---- Dry-run.
  if (dryRun) {
    const dryData: ReportsEditDryRunData = { applied_changes: appliedChanges };
    const envelope = dryRunEnvelope({
      schema: SCHEMA,
      data: dryData,
      would: { method: 'POST', path: reportPath(id), body },
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    render(mode, envelope, (d) => renderReportsEditHuman(d));
    return;
  }

  // ---- Live POST.
  const client = await buildClient(appConfig, env);
  const result = await editReport(client, id, {
    body,
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });

  emitLiveEnvelope(result, appliedChanges, undefined, appConfig);
}

/* ---------------------------------------------------------------------------
 *  Batch flow — `--stdin` (NDJSON)
 * ------------------------------------------------------------------------- */

async function runBatchFromStdin(
  opts: EditOpts,
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
      writeBatchError(result.error, i, /* idMaybe */ null, mode);
      exitAcc.observe(result.error.exitCode);
      continue;
    }
    const row: BatchLine = result.value;
    // Per-row empty-edit rejected.
    if (row.minutes === undefined && row.note === undefined && row.date === undefined) {
      const err = new ValidationError(
        `Line ${i + 1}: at least one of 'minutes', 'note', or 'date' is required (empty edit).`,
        { hintNext: 'Each row must include at least one change field.' },
      );
      writeBatchError(err, i, row.id, mode);
      exitAcc.observe(err.exitCode);
      continue;
    }
    try {
      await runOneBatchLine(row, i, opts.dryRun === true, appConfig, getClient);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, row.id, mode);
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

  const apiInput: EditReportInput = {
    ...(row.minutes !== undefined ? { minutes: row.minutes } : {}),
    ...(row.date !== undefined ? { dateReported: row.date } : {}),
    ...(row.note !== undefined ? { note: row.note } : {}),
  };
  const body = buildEditReportBody(apiInput);

  const appliedChanges: ReportsEditAppliedChanges = {};
  if (row.minutes !== undefined) appliedChanges.minutes = row.minutes;
  if (row.note !== undefined) appliedChanges.note = row.note;
  if (row.date !== undefined) appliedChanges.date_reported = row.date;

  if (dryRun) {
    const dryData: ReportsEditDryRunData = {
      applied_changes: appliedChanges,
      line_index: lineIndex,
    };
    const envelope = dryRunEnvelope({
      schema: SCHEMA,
      data: dryData,
      would: { method: 'POST', path: reportPath(row.id), body },
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    render(mode, envelope, (d) => renderReportsEditHuman(d));
    return;
  }

  const client = await getClient();
  const result = await editReport(client, row.id, {
    body,
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });

  emitLiveEnvelope(result, appliedChanges, lineIndex, appConfig);
}

/* ---------------------------------------------------------------------------
 *  Helpers
 * ------------------------------------------------------------------------- */

function emitLiveEnvelope(
  result: EditReportResult,
  appliedChanges: ReportsEditAppliedChanges,
  lineIndex: number | undefined,
  appConfig: PartialAppConfig,
): void {
  const mode = appConfig.output.mode;
  const data: ReportsEditLiveData = {
    report: projectReport(result.report),
    applied_changes: appliedChanges,
    ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
  };
  const envelope: Envelope<ReportsEditLiveData> = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: result.raw.rateLimit.remaining,
      reset_at: result.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  render(mode, envelope, (d) => renderReportsEditHuman(d));
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
  idMaybe: number | null,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    const idPart = idMaybe === null ? '' : ` (report #${idMaybe})`;
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
  if (idMaybe !== null) context['report_id'] = idMaybe;
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
