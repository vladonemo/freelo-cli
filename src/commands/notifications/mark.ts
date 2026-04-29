/**
 * Shared command logic for `freelo notifications read` and
 * `freelo notifications unread` (R28, spec 0040).
 *
 * Both commands have identical CLI surfaces (variadic `<id>...` plus `--ids`
 * plus `--stdin` plus `--dry-run`) and the same batch flow — only the verb
 * (and therefore the wire endpoint and schema discriminant) differ. `read`
 * additionally accepts `--all-unread` which fans out to a paginated GET
 * followed by per-id POSTs.
 *
 * Mirrors `src/commands/tasks/transition.ts` byte-for-byte except:
 *   - No pre-check GET (no `getNotificationDetail` exists in the API).
 *   - No `already_in_target_state` field in the envelope (decision 03).
 *   - `read` carries an extra `--all-unread` source not present on `unread`.
 *
 * Spec 0040 §3.4 / §3.8 / decision 07.
 */

import { z } from 'zod';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  getAllNotifications,
  markNotificationAsRead,
  markNotificationAsUnread,
  markNotificationReadPath,
  markNotificationUnreadPath,
  type NotificationsListResult,
} from '../../api/notifications.js';
import {
  type Notification,
  type NotificationsReadData,
  type NotificationsUnreadData,
} from '../../api/schemas/notification.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../lib/batch.js';
import { fetchAllPages, PartialPagesError, type NormalizedPage } from '../../api/pagination.js';
import {
  renderNotificationsMarkHuman,
  renderBatchItemFailureHuman,
} from '../../ui/human/notifications-mark.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { BaseError } from '../../errors/base.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

/* ---------------------------------------------------------------------------
 *  Public types
 * ------------------------------------------------------------------------- */

type MarkData = NotificationsReadData | NotificationsUnreadData;

export type MarkOpts = {
  ids?: string;
  stdin?: true;
  allUnread?: true;
  dryRun?: true;
};

/** Per-verb wiring — locked at register time. */
type VerbWiring = {
  /** CLI-visible name. */
  cliName: 'read' | 'unread';
  /** Schema discriminant for the success envelope. */
  schema: SchemaString;
  /** Description used in command help. */
  description: string;
  /** When true, register `--all-unread` (only `read` supports this). */
  supportsAllUnread: boolean;
};

const READ: VerbWiring = {
  cliName: 'read',
  schema: 'freelo.notifications.read/v1',
  description:
    'Mark notifications as read. Server-side idempotent: re-marking an already-read notification is a safe 200. Supports positional <id>... / --ids / --stdin / --all-unread.',
  supportsAllUnread: true,
};

const UNREAD: VerbWiring = {
  cliName: 'unread',
  schema: 'freelo.notifications.unread/v1',
  description:
    'Mark notifications as unread (re-surface). Server-side idempotent: re-marking is safe. Supports positional <id>... / --ids / --stdin.',
  supportsAllUnread: false,
};

/* ---------------------------------------------------------------------------
 *  Input parsers — typed errors per Calibration §2.
 * ------------------------------------------------------------------------- */

function parsePositiveInt(label: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`${label} must be a positive integer.`, {
      hintNext: `${label} is the numeric notification id from \`freelo notifications list\`.`,
    });
  }
  return n;
}

function collectNotificationId(raw: string, prev: number[] | undefined): number[] {
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
      hintNext: '--ids takes a comma- or space-separated list of numeric notification ids.',
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
 *  Public registrars (one per verb)
 * ------------------------------------------------------------------------- */

export function registerRead(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  registerVerb(parent, getConfig, env, READ);
}

export function registerUnread(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  registerVerb(parent, getConfig, env, UNREAD);
}

function registerVerb(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
  wiring: VerbWiring,
): void {
  const meta: CommandMeta = {
    outputSchema: wiring.schema,
    destructive: false,
  };

  let cmd = parent
    .command(wiring.cliName)
    .description(wiring.description)
    .argument(
      '[id...]',
      'One or more numeric notification ids (positional).',
      collectNotificationId,
    )
    .option(
      '--ids <list>',
      'Comma- or space-separated list of notification ids (mutex with positional and --stdin).',
    )
    .option(
      '--stdin',
      'Read NDJSON from stdin (one `{"id": <int>}` per line). Mutex with positional and --ids.',
    )
    .option('--dry-run', 'Skip the POST per id. Envelope echoes the wire path in `would`.');
  if (wiring.supportsAllUnread) {
    cmd = cmd.option(
      '--all-unread',
      'Drain the unread feed: list all unread notifications, then mark each as read. Mutex with positional and --ids and --stdin.',
    );
  }
  attachMeta(cmd, meta);

  cmd.action(async (ids: number[] | undefined, opts: MarkOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      validateInputSources(ids, opts, wiring);

      if (opts.allUnread === true) {
        await runAllUnread(opts, appConfig, env, wiring);
        return;
      }

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
        // Silent success exit 0 — matches R11 batch convention.
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

function validateInputSources(ids: number[] | undefined, opts: MarkOpts, wiring: VerbWiring): void {
  const hasPositional = ids !== undefined && ids.length > 0;
  const hasIdsFlag = opts.ids !== undefined && opts.ids.trim().length > 0;
  const hasStdin = opts.stdin === true;
  const hasAllUnread = opts.allUnread === true;
  const sourceCount =
    (hasPositional ? 1 : 0) + (hasIdsFlag ? 1 : 0) + (hasStdin ? 1 : 0) + (hasAllUnread ? 1 : 0);
  if (sourceCount > 1) {
    const sources = wiring.supportsAllUnread
      ? 'positional <id>..., --ids, --stdin, or --all-unread'
      : 'positional <id>..., --ids, or --stdin';
    throw new ValidationError(`Pick exactly one input source: ${sources}.`, {
      hintNext: 'Combining input sources is ambiguous — agents should pre-resolve to one shape.',
    });
  }
}

/* ---------------------------------------------------------------------------
 *  Batch from --stdin (NDJSON)
 * ------------------------------------------------------------------------- */

async function runBatchFromStdin(
  opts: MarkOpts,
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
      writeBatchError(result.error, i, /* idMaybe */ null, mode, /* fromStdin */ true);
      exitAcc.observe(result.error.exitCode);
      continue;
    }
    const id = result.value.id;
    try {
      const client = await getClient();
      await runOneId(id, opts, appConfig, wiring, client, i, /* fromStdin */ true, false);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, id, mode, /* fromStdin */ true);
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
  opts: MarkOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
  wiring: VerbWiring,
  fromStdin: boolean,
): Promise<void> {
  const mode = appConfig.output.mode;
  const client = await buildClient(appConfig, env);

  if (ids.length === 1) {
    await runOneId(ids[0]!, opts, appConfig, wiring, client, undefined, fromStdin, false);
    return;
  }

  const exitAcc = new ExitCodeAccumulator();
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i]!;
    try {
      await runOneId(id, opts, appConfig, wiring, client, i, fromStdin, false);
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, id, mode, fromStdin);
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
 *  --all-unread flow (read.ts only)
 *
 *  1. Fetch every page of unread notifications via fetchAllPages.
 *  2. Extract id[] from data.
 *  3. Empty? → emit a `notice` envelope (decision 06), exit 0.
 *  4. Otherwise → POST each id (or echo `would` per `--dry-run`).
 *  5. Per-id failures: per-id error env, accumulate exit code, continue.
 *  6. PartialPagesError mid-list: emit notice envelope with the partial id
 *     count, process the partial set, re-throw the partial cause as exit code.
 * ------------------------------------------------------------------------- */

async function runAllUnread(
  opts: MarkOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
  wiring: VerbWiring,
): Promise<void> {
  const mode = appConfig.output.mode;
  const client = await buildClient(appConfig, env);

  let merged: NormalizedPage<Notification>;
  let partialPages: PartialPagesError<Notification> | null = null;
  let lastResult: NotificationsListResult | undefined;

  const fetchPageFn = async (p: number): Promise<NormalizedPage<Notification>> => {
    const r = await getAllNotifications(client, {
      page: p,
      filters: { onlyUnread: true },
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    lastResult = r;
    return r.page;
  };

  try {
    merged = await fetchAllPages({ fetchPage: fetchPageFn });
  } catch (err: unknown) {
    if (err instanceof PartialPagesError) {
      partialPages = err as PartialPagesError<Notification>;
      merged = partialPages.accumulated;
    } else {
      // List call failed before any successful page; bubble up.
      throw err;
    }
  }
  // Mark `lastResult` as intentionally retained for rate-limit propagation.
  void lastResult;

  const ids = merged.data.map((n) => n.id);

  if (ids.length === 0) {
    // Empty unread set → notice envelope (decision 06).
    const data: MarkData = {};
    const envelope = buildEnvelope({
      schema: wiring.schema,
      data,
      ...(lastResult !== undefined
        ? {
            rateLimit: {
              remaining: lastResult.raw.rateLimit.remaining,
              reset_at: lastResult.raw.rateLimit.resetAt,
            },
          }
        : {}),
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      notice: 'No unread notifications.',
    });
    writeEnvelope(envelope, mode, wiring);
    if (partialPages !== null) {
      // Surface the underlying list failure as exit code.
      throw partialPages.innerCause;
    }
    return;
  }

  // Per-id POSTs.
  const exitAcc = new ExitCodeAccumulator();
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i]!;
    try {
      await runOneId(
        id,
        opts,
        appConfig,
        wiring,
        client,
        i,
        /* fromStdin */ false,
        /* fromAllUnread */ true,
      );
    } catch (err: unknown) {
      const typed = toBaseError(err);
      writeBatchError(typed, i, id, mode, /* fromStdin */ false);
      exitAcc.observe(typed.exitCode);
    }
  }

  if (partialPages !== null) {
    // Some ids ran (or the partial set was non-empty). Surface the underlying
    // list failure via the standard top-level error path; that writes the
    // error envelope to stderr and sets the exit code higher than any per-id
    // failure.
    throw partialPages.innerCause;
  }

  if (exitAcc.value !== 0) {
    const { drainDispatcher, exitDeferred } = await import('../../errors/handle.js');
    await drainDispatcher();
    await exitDeferred(exitAcc.value);
  }
}

/* ---------------------------------------------------------------------------
 *  Per-id flow (POST or dry-run echo)
 * ------------------------------------------------------------------------- */

async function runOneId(
  id: number,
  opts: MarkOpts,
  appConfig: PartialAppConfig,
  wiring: VerbWiring,
  client: HttpClient,
  inputIndex: number | undefined,
  fromStdin: boolean,
  fromAllUnread: boolean,
): Promise<void> {
  const mode = appConfig.output.mode;
  const wirePath =
    wiring.cliName === 'read' ? markNotificationReadPath(id) : markNotificationUnreadPath(id);

  // Dry-run: skip the POST, echo `would`.
  if (opts.dryRun === true) {
    const data: MarkData = {
      notification_id: id,
      would: { method: 'POST', path: wirePath, body: {} },
      ...(fromStdin && inputIndex !== undefined ? { line_index: inputIndex } : {}),
      ...(!fromStdin && inputIndex !== undefined ? { input_index: inputIndex } : {}),
      ...(fromAllUnread ? { source: 'all-unread' as const } : {}),
    };
    const envelope: Envelope<MarkData> = {
      schema: wiring.schema,
      data,
      dry_run: true,
    };
    if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
    writeEnvelope(envelope, mode, wiring);
    return;
  }

  // Live POST. The server is idempotent, so we don't pre-check.
  const result =
    wiring.cliName === 'read'
      ? await markNotificationAsRead(client, id, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        })
      : await markNotificationAsUnread(client, id, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });

  const data: MarkData = {
    notification_id: id,
    posted: true,
    ...(fromStdin && inputIndex !== undefined ? { line_index: inputIndex } : {}),
    ...(!fromStdin && inputIndex !== undefined ? { input_index: inputIndex } : {}),
    ...(fromAllUnread ? { source: 'all-unread' as const } : {}),
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
  writeEnvelope(envelope, mode, wiring);
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
  envelope: Envelope<MarkData>,
  mode: 'human' | 'json' | 'ndjson',
  wiring: VerbWiring,
): void {
  if (mode === 'human') {
    const line = renderNotificationsMarkHuman(envelope.data, wiring.cliName);
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function writeBatchError(
  err: BaseError,
  index: number,
  notificationIdMaybe: number | null,
  mode: 'human' | 'json' | 'ndjson',
  fromStdin: boolean,
): void {
  if (mode === 'human') {
    process.stdout.write(
      `${renderBatchItemFailureHuman(index, notificationIdMaybe, err.message)}\n`,
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
  if (notificationIdMaybe !== null) context['notification_id'] = notificationIdMaybe;
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
