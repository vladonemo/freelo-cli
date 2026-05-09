/**
 * `freelo projects invite` (R33, spec 0046).
 *
 * Single bulk POST to `/users/manage-workers`. Three repeatable input flags:
 *   - `--project <id>` (required, ≥ 1)
 *   - `--user <id>` (optional individually)
 *   - `--email <addr>` (optional individually)
 *
 * `--user` and `--email` are NOT mutex (decision 2 — the wire body accepts
 * both in one call). At least one of them must be non-empty after dedup.
 *
 * Reuses the `--dry-run` pattern (R09) and the repeatable-flag dedup pattern
 * from R32 (spec 0045). No `confirmDestructive` — invite is additive.
 *
 * Calibration §2: every typed error class triggered has an exit-code
 * asserting test.
 * Calibration §4: the new try/catch arm (400-error hint rewrite) has explicit
 * coverage in `test/commands/projects/invite.test.ts`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import { inviteUsersToProjects, projectsInvitePath } from '../../api/projects-invite.js';
import { type ProjectsInviteBody, type ProjectsInviteData } from '../../api/schemas/project.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderProjectsInviteHuman } from '../../ui/human/projects-invite.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

const SCHEMA: SchemaString = 'freelo.projects.invite/v1';

export const inviteMeta: CommandMeta = {
  outputSchema: SCHEMA,
  destructive: false,
};

type InviteOpts = {
  project?: number[];
  user?: number[];
  email?: string[];
  dryRun?: true;
};

/* ===========================================================================
 *  Parsers
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

function collectProjectId(raw: string, prev: number[] | undefined): number[] {
  const n = parsePositiveInt('--project', raw);
  return prev ? [...prev, n] : [n];
}

function collectUserId(raw: string, prev: number[] | undefined): number[] {
  const n = parsePositiveInt('--user', raw);
  return prev ? [...prev, n] : [n];
}

/**
 * Loose email regex — mirrors the existing pattern in `auth login` and R32
 * `workers remove`. Server is the authority; this catches obvious typos
 * client-side.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function collectEmail(raw: string, prev: string[] | undefined): string[] {
  const trimmed = raw.trim();
  if (!EMAIL_RE.test(trimmed)) {
    throw new ValidationError(`--email '${raw}' is not a valid email address.`, {
      hintNext: '--email must be `local@domain`. Repeat the flag for multiple recipients.',
    });
  }
  return prev ? [...prev, trimmed] : [trimmed];
}

/* ===========================================================================
 *  Registration
 * ========================================================================= */

export function registerInvite(
  projects: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = projects
    .command('invite')
    .description(
      'Invite existing users (--user) and/or external people (--email) to one or more projects (--project). Single bulk POST to /users/manage-workers; --user and --email are not mutex (the API body accepts both in one call). Unknown emails trigger user creation server-side.',
    )
    .option(
      '--project <id>',
      'Numeric project id (repeatable). Required: at least one. The whole call is atomic across all projects.',
      collectProjectId,
    )
    .option(
      '--user <id>',
      'Numeric user id of an existing Freelo user (repeatable). Combine with --email in the same invocation if you wish.',
      collectUserId,
    )
    .option(
      '--email <addr>',
      'Email address (repeatable). Unknown addresses trigger user creation server-side. Combine with --user in the same invocation if you wish.',
      collectEmail,
    )
    .option('--dry-run', 'Skip the POST; envelope echoes the call that would have been sent.');
  attachMeta(cmd, inviteMeta);

  cmd.action(async (opts: InviteOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      const validated = validateInviteInput(opts);

      // ---- Dry-run: skip the POST. Emit envelope echo only.
      if (opts.dryRun === true) {
        const data = buildDryRunData(validated);
        const envelope: Envelope<ProjectsInviteData> = {
          schema: SCHEMA,
          data,
          dry_run: true,
        };
        if (appConfig.requestId !== undefined) envelope.request_id = appConfig.requestId;
        renderEnvelope(envelope, mode);
        return;
      }

      // ---- Live POST.
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

      const body = buildInviteBody(validated);

      try {
        const r = await inviteUsersToProjects(client, body, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });

        const data: ProjectsInviteData = {
          projects_ids: validated.projectsIds,
          ...(validated.usersIds.length > 0 ? { users_ids: validated.usersIds } : {}),
          ...(validated.emails.length > 0 ? { emails: validated.emails } : {}),
          result: r.result,
        };
        const envelope = buildEnvelope({
          schema: SCHEMA,
          data,
          rateLimit: {
            remaining: r.raw.rateLimit.remaining,
            reset_at: r.raw.rateLimit.resetAt,
          },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        renderEnvelope(envelope, mode);
      } catch (err: unknown) {
        throw rewriteInviteApiHint(err);
      }
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ===========================================================================
 *  Input validation
 * ========================================================================= */

type ValidatedInput = {
  projectsIds: number[];
  usersIds: number[];
  emails: string[];
};

/**
 * Validate `--project`, `--user`, `--email` inputs:
 *   - `--project` ≥ 1 after dedup.
 *   - At least one of `--user` / `--email` non-empty after dedup.
 *   - All three repeatable arrays deduplicated first-seen-wins.
 *
 * Throws `ValidationError` on any failure.
 */
function validateInviteInput(opts: InviteOpts): ValidatedInput {
  const projectIn = opts.project ?? [];
  if (projectIn.length === 0) {
    throw new ValidationError('--project is required (repeatable; pass at least one).', {
      hintNext: '--project is the numeric project id from `freelo projects list`.',
    });
  }
  const projectsIds = dedupNumbers(projectIn);

  const userIn = opts.user ?? [];
  const emailIn = opts.email ?? [];
  if (userIn.length === 0 && emailIn.length === 0) {
    throw new ValidationError('At least one of --email or --user must be supplied.', {
      hintNext:
        'Pass --email <addr> or --user <id> (both repeatable; both can be combined in one invocation).',
    });
  }
  const usersIds = dedupNumbers(userIn);
  const emails = dedupStrings(emailIn);

  return { projectsIds, usersIds, emails };
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

/* ===========================================================================
 *  Body / envelope builders
 * ========================================================================= */

/**
 * Build the wire body. `users_ids` and `emails` are emitted only when
 * non-empty (post-dedup) — the OpenAPI body permits them missing entirely.
 */
function buildInviteBody(v: ValidatedInput): ProjectsInviteBody {
  const body: ProjectsInviteBody = { projects_ids: v.projectsIds };
  if (v.usersIds.length > 0) body.users_ids = v.usersIds;
  if (v.emails.length > 0) body.emails = v.emails;
  return body;
}

function buildDryRunData(v: ValidatedInput): ProjectsInviteData {
  const body = buildInviteBody(v);
  return {
    projects_ids: v.projectsIds,
    ...(v.usersIds.length > 0 ? { users_ids: v.usersIds } : {}),
    ...(v.emails.length > 0 ? { emails: v.emails } : {}),
    would: {
      method: 'POST',
      path: projectsInvitePath(),
      body,
    },
  };
}

function renderEnvelope(
  envelope: Envelope<ProjectsInviteData>,
  mode: 'human' | 'json' | 'ndjson',
): void {
  render(mode, envelope, (d) => renderProjectsInviteHuman(d));
}

/* ===========================================================================
 *  API error → friendlier hint
 * ========================================================================= */

/**
 * Map a `FreeloApiError` thrown by the invite POST to a friendlier
 * `hintNext` for 400 / 403 / 404 / 422. Mirrors `projects workers remove`
 * (spec 0045 §3.5) and `projects create` (spec 0042 §4).
 *
 * 400 hint logic scans BOTH `err.message` (synthetic) AND `err.errors[]`
 * (server-supplied field-level strings). Spec 0046 decision 8.
 *
 * Calibration §4: this catch arm is covered by tests.
 */
function rewriteInviteApiHint(err: unknown): unknown {
  if (!(err instanceof FreeloApiError)) return err;

  if (err.httpStatus === 400) {
    const haystack = [err.message, ...(err.errors ?? [])].join(' ').toLowerCase();
    let hintNext: string;
    if (haystack.includes('emails')) {
      hintNext =
        'Server-side validation rejected the email list. Verify each --email is a valid address (and not already pending in the project).';
    } else if (haystack.includes('users_ids') || haystack.includes('user_ids')) {
      hintNext =
        'Server-side validation rejected the user-id list. Verify each --user id exists (try `freelo users list` once R48 ships).';
    } else if (haystack.includes('projects_ids') || haystack.includes('project_ids')) {
      hintNext =
        'Server-side validation rejected the project-id list. Verify each --project id exists with `freelo projects list`.';
    } else {
      hintNext =
        'Server-side validation rejected the request; review the message and adjust the --project / --user / --email flags.';
    }
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext,
    });
  }
  if (err.httpStatus === 403) {
    const haystack = [err.message, ...(err.errors ?? [])].join(' ').toLowerCase();
    const planLikely = /plan|seat|limit|exceed/i.test(haystack);
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: planLikely
        ? 'Account plan limit reached (seats exceeded). Upgrade the plan or remove inactive workers, then retry.'
        : 'Account does not have permission to invite to every project in --project. Caller must have invite rights on each.',
    });
  }
  if (err.httpStatus === 404) {
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext:
        'One or more --project ids not found, or your account does not have access to all of them.',
    });
  }
  if (err.httpStatus === 422) {
    const haystack = [err.message, ...(err.errors ?? [])].join(' ').toLowerCase();
    const planLikely = /plan|seat|limit|exceed/i.test(haystack);
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: planLikely
        ? 'Account plan limit reached (seats exceeded). Upgrade the plan or remove inactive workers, then retry.'
        : 'Server rejected the request as semantically invalid; review the message.',
    });
  }
  return err;
}
