/**
 * `freelo task-labels merge --from <uuid>... --to <uuid>` (M06, spec 0068).
 *
 * Consolidates duplicate task labels: every task carrying a source label ends
 * up carrying the target label instead, in one server-side call.
 *
 * Maps to **`POST /task-labels/merge`** (yaml :2936-2981). Body is
 * `{ from_uuids, to_uuid }` — no `labels` array, no path parameter, which
 * makes it the odd one out in this resource group.
 *
 * **This is the most destructive command in the CLI.** It relabels an
 * unbounded number of tasks across the whole account in one call, and Freelo
 * exposes no undo. Hence: confirmation gate (`--yes` or a TTY prompt; non-TTY
 * without `--yes` fails closed with `CONFIRMATION_REQUIRED`, exit 2), a
 * `--dry-run` that reaches neither the network nor the credential store, and
 * an envelope that refuses to overstate what happened.
 *
 * ## The honesty problem, and what the envelope does about it
 *
 * The 200 body is `{ "result": "success" }` (yaml :2974-2981). It carries no
 * task count, no list of affected tasks, and no indication of what was
 * skipped. Meanwhile the contract says the replacement is applied **only to
 * tasks in projects where the caller is a commander** (yaml :2948) — so a
 * merge across a large account routinely leaves tasks untouched, and nothing
 * in the response says which or how many.
 *
 * So the envelope reports what was **sent**, never what was **changed**:
 * `to_uuid`, `from_uuids`, `count`. No `tasks_updated`, no `tasks_skipped`, no
 * `already_in_target_state` — inventing any of them would be fabricating a
 * measurement the CLI cannot take (spec 0068 §D1; M03 decision 5 precedent).
 *
 * The one constant it does carry is `scope: 'commander_projects'`, because
 * help text cannot reach a JSON consumer and an unqualified success reads as a
 * completeness claim. It restates a contract fact rather than measuring
 * anything (spec 0068 §D1b).
 *
 * ## Batch surfaces
 *
 * `--from` is repeatable **and** accepts a comma/space-separated list per
 * occurrence. There is no `--ids` and no `--stdin`: the repo's batch
 * convention exists to drive N independent operations with a per-item
 * envelope each, and merge is one call whose body already holds the array —
 * there is no per-source request to amortise and no per-source result to
 * report. Spec 0068 §D2.
 *
 * Output schema: `freelo.task_labels.merge/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  buildMergeTaskLabelsBody,
  mergeTaskLabels,
  TASK_LABELS_MERGE_PATH,
} from '../../api/task-labels.js';
import { type TaskLabelsMergeData } from '../../api/schemas/task-label.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { renderTaskLabelsMergeHuman } from '../../ui/human/task-labels-merge.js';
import { confirmDestructive } from '../../lib/confirm.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.task_labels.merge/v1',
  destructive: true,
};

const SCHEMA: SchemaString = 'freelo.task_labels.merge/v1';

/**
 * Strict 8-4-4-4-12 hex pattern. Local to the command file, matching the
 * codebase habit (`files/delete.ts`, `files/download.ts` each keep their own).
 */
const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type MergeOpts = {
  from?: string[];
  to?: string;
  dryRun?: true;
};

/* ---------------------------------------------------------------------------
 *  Input parsing
 *
 *  Commander parsers throw `ValidationError` (BaseError, exit 2) — NOT
 *  Commander's `InvalidArgumentError`, which maps to exit 1. Calibration §2.
 * ------------------------------------------------------------------------- */

function parseUuid(label: string, raw: string): string {
  if (!UUID_REGEX.test(raw)) {
    throw new ValidationError(`${label} must be a UUID (8-4-4-4-12 hex pattern).`, {
      hintNext: `${label} is a task-label uuid. Run \`freelo task-labels find\` to list them.`,
    });
  }
  return raw;
}

/**
 * `--from` collector. Commander calls this once per occurrence; each
 * occurrence may itself carry a comma- or space-separated list, so
 * `--from a,b,c` and `--from a --from b --from c` are equivalent.
 *
 * A uuid can never contain a comma or whitespace, so the split is unambiguous
 * — which is exactly why this can replace a separate `--ids` flag instead of
 * sitting beside one (spec 0068 §D2).
 */
function collectFromUuids(raw: string, prev: string[] | undefined): string[] {
  const tokens = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) {
    throw new ValidationError('--from requires at least one UUID.', {
      hintNext: '--from takes a task-label uuid, or a comma-separated list of them.',
    });
  }
  const parsed = tokens.map((t) => parseUuid('--from', t));
  return prev ? [...prev, ...parsed] : parsed;
}

function parseToUuid(raw: string): string {
  return parseUuid('--to', raw);
}

/* ---------------------------------------------------------------------------
 *  Confirmation copy
 * ------------------------------------------------------------------------- */

/**
 * Build the confirmation prompt. Exported so the copy can be asserted in a
 * plain unit test, where `isInteractive()` never enters the picture —
 * calibration §7's preferred shape for testing prompt wording.
 *
 * The copy names the irreversibility outright. This is the last thing standing
 * between a typo'd uuid and an account-wide relabel, so it does not soften it.
 */
export function mergeConfirmMessage(fromCount: number, toUuid: string): string {
  const noun = fromCount === 1 ? 'label' : 'labels';
  return `Merge ${fromCount} ${noun} into ${toUuid}? Every task carrying ${
    fromCount === 1 ? 'it' : 'them'
  } is relabeled. This cannot be undone.`;
}

/* ---------------------------------------------------------------------------
 *  Source-list normalisation
 * ------------------------------------------------------------------------- */

/**
 * De-duplicate case-insensitively, preserving input order and the first
 * spelling seen. Two uuids differing only in hex case denote the same label,
 * so sending both would be a redundant wire payload rather than a user error
 * (spec 0068 §3.1.5).
 */
export function dedupeUuids(uuids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of uuids) {
    const key = u.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerMerge(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = parent
    .command('merge')
    .description(
      'Merge one or more source task labels into a target label in a single server-side call. Every task carrying a source label ends up carrying the target label instead. Destructive and irreversible — requires --yes (non-TTY) or interactive confirmation (TTY); Freelo has no undo endpoint. Two limits are worth knowing before you run it: the replacement reaches only tasks in projects where you are a commander, so tasks elsewhere silently keep the old label and neither the CLI nor the API can say how many; and the source label definitions are detached from tasks but not deleted, with no endpoint anywhere in the API to remove them afterwards. The target label keeps its own name and color. Both --to and every --from label must be owned by you: labels you do not own answer 404, not 403.',
    )
    .option(
      '--from <uuid>',
      'UUID of a source label to merge away. Repeatable, and each occurrence also accepts a comma- or space-separated list. At least one is required.',
      collectFromUuids,
    )
    .option(
      '--to <uuid>',
      'UUID of the target label the sources are merged into. Required. Its name and color are unchanged by this call.',
      parseToUuid,
    )
    .option(
      '--dry-run',
      'Skip the POST. No confirmation prompt fires and no credentials are read. Envelope reflects what would have been sent.',
    );
  // NOTE: `--yes` / `-y` is the **global** flag (registered on the root
  // program in `src/bin/freelo.ts`), so it is not in this subcommand's opts.
  attachMeta(cmd, meta);

  cmd.action(async (opts: MergeOpts, cmdCtx: Command) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;
    const yes = resolveYesFlag(cmdCtx);

    try {
      const { fromUuids, toUuid } = validateInputs(opts);

      // 1. Confirmation gate — once, before anything else. `--dry-run` and
      //    `--yes` both short-circuit it inside `confirmDestructive`.
      await confirmDestructive({
        promptMessage: mergeConfirmMessage(fromUuids.length, toUuid),
        yes,
        dryRun: opts.dryRun === true,
      });

      const body = buildMergeTaskLabelsBody({ fromUuids, toUuid });

      // 2. Dry-run: no credentials, no wire call. Mirrors M01/M07.
      if (opts.dryRun === true) {
        const data: TaskLabelsMergeData = {
          to_uuid: toUuid,
          from_uuids: [...fromUuids],
          count: fromUuids.length,
          scope: 'commander_projects',
          would: { method: 'POST', path: TASK_LABELS_MERGE_PATH, body },
        };
        const envelope: Envelope<TaskLabelsMergeData> = { schema: SCHEMA, data, dry_run: true };
        if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
        writeEnvelope(envelope, mode);
        return;
      }

      // 3. Live merge.
      const client = await buildClient(appConfig, env);
      let result;
      try {
        result = await mergeTaskLabels(client, {
          body,
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
      } catch (err: unknown) {
        // Presentation only. This rewriter never converts an error into a
        // success — see `rewriteMergeError`.
        throw rewriteMergeError(err);
      }

      const data: TaskLabelsMergeData = {
        to_uuid: toUuid,
        from_uuids: [...fromUuids],
        count: fromUuids.length,
        scope: 'commander_projects',
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
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/**
 * Walk up to the root program and read the global `--yes` (`-y`). Mirrors
 * `src/commands/files/delete.ts` and `src/commands/comments/delete.ts`.
 *
 * Defensive: an unreachable root falls back to `false` — the safe default for
 * a destructive command.
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
 *  Validation (spec 0068 §3.1) — every branch exits 2.
 * ------------------------------------------------------------------------- */

function validateInputs(opts: MergeOpts): { fromUuids: string[]; toUuid: string } {
  const rawFrom = opts.from ?? [];

  // `--to` is checked with a hand-written branch rather than Commander's
  // `.requiredOption()`, which exits 1. Calibration §2.
  if (opts.to === undefined) {
    throw new ValidationError('--to is required.', {
      hintNext:
        '--to is the uuid of the label that survives the merge. Run `freelo task-labels find` to list uuids.',
    });
  }
  if (rawFrom.length === 0) {
    throw new ValidationError('--from is required (at least one source label uuid).', {
      hintNext:
        'Pass --from <uuid> once per source label, or a comma-separated list in one --from.',
    });
  }

  const fromUuids = dedupeUuids(rawFrom);
  const toUuid = opts.to;

  // Self-merge. The contract does not say what the server does when `to_uuid`
  // appears in `from_uuids`, and this is not a command to find out on. Fails
  // closed client-side (spec 0068 §3.1.4).
  if (fromUuids.some((u) => u.toLowerCase() === toUuid.toLowerCase())) {
    throw new ValidationError('--to must not also appear in --from.', {
      hintNext:
        'Merging a label into itself is not a defined operation. Drop it from --from and re-run.',
    });
  }

  return { fromUuids, toUuid };
}

/* ---------------------------------------------------------------------------
 *  Endpoint-specific error rewriting (spec 0068 §5.2)
 * ------------------------------------------------------------------------- */

/**
 * Rewrite the one failure this endpoint documents: the `404`.
 *
 * There is deliberately **no 400 branch and no 403 branch** — the `responses:`
 * map declares only `'200'` (yaml :2974), so any message for another status
 * would be invented. Everything except the 404 passes through untouched.
 *
 * The 404 stays an **error**. Merge is notionally idempotent (a repeat merge
 * is a server-side no-op), which makes absorbing the 404 into a success
 * tempting — and wrong. Per yaml :2947 a 404 means the label is missing *or*
 * the caller does not own it, and the two are indistinguishable from the API,
 * so absorbing it would report a completed merge for labels sitting untouched
 * in someone else's account. `src/lib/idempotency.ts` is deliberately not used
 * here. Same call as M07 (`files delete`), reached from this endpoint's own
 * contract sentence rather than by precedent.
 *
 * The message stays plain — no "forbidden", no "permission". The CLI cannot
 * tell which case it hit, so asserting either would be a fabrication. The
 * ownership nuance lives in `hint_next`, including the caveat that
 * `task-labels find` lists a *superset* of the labels the caller owns
 * (yaml :2847 — it includes labels used in invited projects), so it can show a
 * label that merge will still 404 on.
 *
 * `code`, `exitCode`, `retryable`, `errors`, `httpStatus` and `requestId` are
 * all preserved: this is presentation, not reclassification.
 */
function rewriteMergeError(err: unknown): unknown {
  if (!(err instanceof FreeloApiError)) return err;

  if (err.httpStatus === 404) {
    return new FreeloApiError('One or more of the labels was not found.', err.code, {
      httpStatus: err.httpStatus,
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext:
        'Both --to and every --from label must exist and be owned by you. Freelo answers 404 rather than 403 for labels you do not own, so the two cases are indistinguishable from the API (docs/api/freelo-api.yaml :2947). `freelo task-labels find` lists the labels visible to you, which is a superset of the ones you own — it can show a label this call still rejects.',
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
    });
  }

  return err;
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
  envelope: Envelope<TaskLabelsMergeData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  if (mode === 'human') {
    process.stdout.write(`${renderTaskLabelsMergeHuman(envelope.data)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
