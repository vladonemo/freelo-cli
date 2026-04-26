import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import { getTasklistDetail, getAssignableWorkers } from '../../api/tasklists.js';
import { type TasklistShowData } from '../../api/schemas/tasklist.js';
import { buildEnvelope } from '../../ui/envelope.js';
import { renderAsync } from '../../ui/render.js';
import { renderTasklistsShowHuman } from '../../ui/human/tasklists-show.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasklists.show/v1',
  destructive: false,
};

/**
 * Allowed values for `--with` in v1. R06 ships with `assignable-workers`
 * only; the flag plumbing accepts a comma-separated list so future slices
 * can add more values (`tasks` etc.) without breaking the contract.
 *
 * Spec 0016 §3.1 / §6.
 */
const WITH_VALUES = ['assignable-workers'] as const;
type WithValue = (typeof WITH_VALUES)[number];

type ShowOpts = {
  with?: string;
};

/**
 * Parse the `<id>` positional. Throws `ValidationError` (BaseError, exitCode
 * 2) — NOT Commander's `InvalidArgumentError`, which falls through to the
 * synthetic INTERNAL_ERROR (exit 1). Calibration §1-2.
 */
function parseTasklistId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('<id> must be a positive integer.', {
      hintNext: '<id> is the numeric tasklist id from `freelo tasklists list`.',
    });
  }
  return n;
}

/**
 * Parse `--with a,b,c` into a deduplicated array of allowed values.
 *
 * Throws `ValidationError` (exit 2) on:
 *   - Empty string after trim (`--with ""`).
 *   - Any token not in `WITH_VALUES`.
 *
 * Validation runs **before** any HTTP call (mirrors R04's `--with` plumbing
 * and R03's `--fields` discipline).
 */
function parseWithFlag(raw: string | undefined): WithValue[] {
  if (raw === undefined) return [];
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) {
    throw new ValidationError('Specify at least one --with value, or omit --with.', {
      hintNext: 'Specify at least one --with value, or omit --with.',
    });
  }
  const allowed = new Set<string>(WITH_VALUES);
  const seen = new Set<WithValue>();
  for (const t of tokens) {
    if (!allowed.has(t)) {
      throw new ValidationError(
        `Unknown --with value '${t}'. Valid values: ${WITH_VALUES.join(', ')}.`,
        { hintNext: `--with accepts only: ${WITH_VALUES.join(', ')}.` },
      );
    }
    seen.add(t as WithValue);
  }
  return [...seen];
}

export function registerShow(
  tasklists: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = tasklists
    .command('show')
    .description("Show one tasklist's detail, with optional assignable-workers side-car.")
    .argument('<id>', 'Tasklist id (positive integer).', parseTasklistId)
    .option(
      '--with <list>',
      `Comma-separated side-cars to include. Allowed values: ${WITH_VALUES.join(', ')}.`,
    );
  attachMeta(cmd, meta);

  cmd.action(async (id: number, opts: ShowOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // Validate --with synchronously, before any HTTP call.
      const withValues = parseWithFlag(opts.with);
      const wantAssignable = withValues.includes('assignable-workers');

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

      // 1. Mandatory call — fetch tasklist detail.
      let detail: Awaited<ReturnType<typeof getTasklistDetail>>;
      try {
        detail = await getTasklistDetail(client, id, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
      } catch (err: unknown) {
        throw rewriteDetailHint(err, id);
      }

      // 2. Optional side-car — fetch assignable workers.
      // The endpoint requires the project_id from the detail response; the
      // schema declares project_id as required, so by this point it must be
      // a number (zod fails fast otherwise).
      let assignable: Awaited<ReturnType<typeof getAssignableWorkers>> | undefined;
      if (wantAssignable) {
        try {
          assignable = await getAssignableWorkers(client, detail.data.project_id, id, {
            ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
          });
        } catch (err: unknown) {
          throw rewriteAssignableHint(err, id);
        }
      }

      // Build envelope. `data.assignable_workers` only present when requested.
      // When `wantAssignable` is true, `assignable` is guaranteed set above
      // (either successfully assigned or the throw escaped this block).
      const data: TasklistShowData =
        wantAssignable && assignable !== undefined
          ? { tasklist: detail.data, assignable_workers: assignable.data }
          : { tasklist: detail.data };

      const lastRaw = assignable ?? detail;

      const envelope = buildEnvelope({
        schema: 'freelo.tasklists.show/v1',
        data,
        rateLimit: {
          remaining: lastRaw.rateLimit.remaining,
          reset_at: lastRaw.rateLimit.resetAt,
        },
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });

      await renderAsync(mode, envelope, (d) => renderTasklistsShowHuman(d));
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/**
 * Re-throw a `FreeloApiError` with a fresh `hintNext` derived from the resource
 * the call was targeting. Centralises the "preserve every other field, swap
 * the hint" pattern shared by both call sites.
 *
 * Returns the original error unchanged for non-FreeloApiError values and for
 * statuses other than 404 / 403 — the top-level handler renders those as-is.
 */
function rewriteHint(err: unknown, hint404: string, hint403: string): unknown {
  if (!(err instanceof FreeloApiError) || (err.httpStatus !== 404 && err.httpStatus !== 403)) {
    return err;
  }
  const hintNext = err.httpStatus === 404 ? hint404 : hint403;
  // `httpStatus` is narrowed to 404 | 403 above. `errors` / `rawBody` are
  // always-defined fields on FreeloApiError. Only `requestId` is genuinely
  // optional, so it's the one field that needs a conditional spread to
  // satisfy exactOptionalPropertyTypes.
  return new FreeloApiError(err.message, err.code, {
    httpStatus: err.httpStatus,
    errors: err.errors,
    rawBody: err.rawBody,
    hintNext,
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
  });
}

/**
 * Hint rewriter for `getTasklistDetail` failures. Spec 0016 §3.5.
 */
function rewriteDetailHint(err: unknown, tasklistId: number): unknown {
  return rewriteHint(
    err,
    `Tasklist ${tasklistId} not found, or your account does not have access.`,
    `Account does not have permission to view tasklist ${tasklistId}.`,
  );
}

/**
 * Hint rewriter for `getAssignableWorkers` failures. Hint is scoped to the
 * assignable-workers side-car so the user can distinguish "tasklist not
 * found" from "tasklist found but assignable-workers ACL denied" (rare).
 *
 * Spec 0016 §3.5 OQ#3 — separate rewrite per call site.
 */
function rewriteAssignableHint(err: unknown, tasklistId: number): unknown {
  return rewriteHint(
    err,
    `Assignable workers for tasklist ${tasklistId} not found, or your account does not have access.`,
    `Account does not have permission to view assignable workers for tasklist ${tasklistId}.`,
  );
}
