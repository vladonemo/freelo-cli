# Triage — R32 projects workers

**Run:** 2026-05-09-1200-r32-projects-workers
**Tier:** Yellow
**Branch:** `feat/projects-workers`

## Rationale

- Two new user-visible commands (`projects workers list`, `projects workers remove`).
- Two new envelope schemas (`freelo.projects.workers.list/v1`,
  `freelo.projects.workers.remove/v1`) — additive.
- One destructive op (`remove`) — reuses shipped `confirmDestructive` (R13);
  no new auth, HTTP-default, or release-tooling code touched.
- No new dependencies; no global flag changes.
- Changeset stance: `minor`.

## Route flags

- `needsSecurityReview`: false. No auth, credentials, or transport changes.
- `requiresFreeloApi` (specialist agent): false. The OpenAPI documents both
  request bodies and the response shapes; verified at run start (yaml
  :583-619, :676-757). No probe needed.
- `preApprovedDeps`: [] — no new dependencies expected.

## API verb correction (load-bearing)

Roadmap entry says `DELETE /project/{id}/remove-workers/...`. The OpenAPI
documents both as **`POST`**. OpenAPI wins. Logged as decision 1 of the spec.

## API behaviour notes (verified)

- `users_ids` is `integer[]` and `users_emails` is `string[]`. Server
  accepts an array per call (no fan-out). One invocation = one HTTP request.
- "All given IDs are checked at once... if the caller lacks rights to remove
  any single user, the whole request fails (no partial removal)" — atomic.
- The project owner cannot be removed via these endpoints — server 4xx.
- Both endpoints return `SuccessResponse` (`{ result: 'success' }`).
- `--user` and `--email` map to *different* endpoints; they are mutually
  exclusive within one invocation.

## Reuse plan (no reintroduction)

- `src/lib/confirm.ts` (R13) — destructive prompt for `remove`.
- `src/lib/dry-run.ts` semantics (R09) — `--dry-run` mandatory on `remove`.
- `src/lib/idempotency.ts` (R11) — **deferred decision**: re-removing a
  no-longer-worker is server-side documented to fail (by-emails: explicit
  pre-check fails the request; by-ids: not documented as idempotent).
  Per the autonomous rule "API behavior not in OpenAPI → don't guess",
  v1 does **not** map any HTTP error to `already_in_target_state: true`.
  Tracked as decision 6 of the spec; can be revisited when probed.
- `src/api/projects.ts` already exports `getProjectWorkers` — `list` reuses
  it directly. No new wire wrapper needed for the GET.
- `src/commands/projects.ts` already wires sub-leaves; we add a single new
  file `src/commands/projects/workers.ts` that creates the `workers`
  sub-subgroup and registers both leaves. Mirrors the architecture pattern
  used elsewhere (one file per leaf where leaves stand alone, one file per
  group when leaves are tightly coupled — see `transition.ts` for that
  precedent).

## Stuck-loop / calibration reminders for this run

- Calibration §3 amendment: pre-commit gate sequence MUST be
  `pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm fix:readme && pnpm check:readme`.
  Build IMMEDIATELY before fix:readme. No source edits between fix:readme
  and check:readme. If any `src/commands/**` file changes after fix:readme,
  rebuild and re-run check:readme before committing.
- Calibration §7: any test asserting TTY-prompt copy MUST clear
  `process.env['CI']` and restore in `finally`.
- Calibration §1-2: every typed error class triggered must have an exit-code
  asserting test.
