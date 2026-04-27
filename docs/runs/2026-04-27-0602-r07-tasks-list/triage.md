# Triage — R07 tasks list

**Run:** 2026-04-27-0602-r07-tasks-list
**Tier:** Yellow
**Commit type:** feat

## Summary

R07 introduces `freelo tasks list`, the workhorse read for tasks across all
accessible projects. The command unifies three Freelo endpoints (`GET /all-tasks`,
`GET /project/{project_id}/tasklist/{tasklist_id}/tasks`,
`GET /tasklist/{tasklist_id}/finished-tasks`) behind a single CLI surface with
per-route filter validation. Ships with a new shared utility `src/lib/query.ts`
that encodes array params as repeating `key[]=v` pairs (not PHP-bracketed keys)
to satisfy the `with_labels[]` / `projects_ids[]` shape and normalizes the
deprecated singular `with_label` flag to the array form.

## Signals

- [x] Touches src/commands/ (new subcommand `tasks list`)
- [ ] Touches src/config/
- [ ] Touches src/api/client.ts or HTTP defaults
- [ ] Touches auth flows
- [ ] Adds a dependency
- [ ] Removes a dependency
- [x] Changes an envelope schema (new `freelo.tasks.list/v1`)
- [ ] Changes exit codes
- [ ] Removes/renames an existing flag
- [x] Requires the Freelo API
- [ ] Docs-only

## Route flags

- requiresFreeloApi: **true** — three endpoints in `docs/api/freelo-api.yaml`. Architect + freelo-api-specialist must confirm:
  1. The exact filter parameters supported by `/all-tasks` (per OpenAPI), and
     which of them apply to the per-tasklist routes.
  2. Whether `/tasklist/{id}/finished-tasks` returns the same `Task` shape as
     `/all-tasks` so a single zod schema covers all three routes.
  3. Pagination shape parity with R03 (`page`, `per_page`, `total`, `count`).
- needsSecurityReview: **false** — read-only, no auth/HTTP-default changes,
  no secret storage.
- preApprovedDeps: `[]` — no new runtime deps. The `query.ts` lib is
  hand-rolled, no `qs` / `query-string` dependency.
- allowNewDeps: false.

## Rationale

Yellow per `.claude/docs/autonomous-sdlc.md` triggers:

- New user-visible command (`freelo tasks list`) with multiple new public flags.
- New envelope schema `freelo.tasks.list/v1` (additive — no other schema touched).
- Changeset bump = `minor`.
- No `src/config/`, auth, HTTP-client, or release-tooling changes.
- No new runtime dependencies.
- No breaking change to existing envelopes, exit codes, or flags.

Excluded from Green: introduces multiple new public flags + a new public
envelope schema + a new shared `src/lib/query.ts` utility, all Yellow triggers.

Excluded from Red: scope is precise (verbatim CLI signature in the roadmap),
endpoints are listed, no auth/config/client touch, no breaking change.

## Open concerns

For the architect to address in the spec:

1. **Route-selection logic.** The CLI has three flag combinations the spec
   must enumerate:
   - No `--project` and no `--tasklist` → `/all-tasks`.
   - One `--project` AND one `--tasklist` → `/project/{p}/tasklist/{t}/tasks`.
   - `--finished-overdue`, `--finished-from`, `--finished-to` → only valid
     with exactly one `--tasklist` (and require `/tasklist/{t}/finished-tasks`).
   - Multiple `--project` or `--tasklist` → `/all-tasks` with array params.
   The spec must spell out which validation errors are raised when flags
   conflict (e.g. `--finished-from` without `--tasklist`).

2. **`with_label` (singular, deprecated) vs `with_labels[]` (array).** Per
   the requirement, the CLI exposes only `--label <name>` (repeatable) and
   normalizes to `with_labels[]`. The OpenAPI spec must be checked for whether
   `with_label` is still listed as deprecated and whether passing both is
   defined behavior.

3. **`without-label`.** The CLI exposes `--without-label <name>`. The OpenAPI
   spec must confirm the parameter name (likely `without_labels[]` or
   `without_label`).

4. **`--page N|--all` semantics.** Pagination behavior (single page vs
   auto-paginate-and-aggregate) per R03 conventions.

5. **`--fields` shape.** Comma-separated allow-list applied at the renderer.

6. **`--no-due`.** Whether this maps to a Freelo filter or a client-side filter.

## Calibration log carry-over (binding for this run)

1. Test phase mandatory; exit-code assertions on every typed error class
   triggered (`ValidationError`, `FreeloApiError`, `NetworkError`,
   `RateLimitedError`).
2. Run gates AFTER commit on the clean committed tree
   (`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`).
3. Coverage threshold `src/commands/** ≥ 85% branches` enforced by branch protection.
4. New `try/catch` arms must each have a test.
5. Branch must come from freshly-pulled `main`.
6. CI required-status-check on `main` is active.

## Phase routing

1. Spec — architect + freelo-api-specialist (parallel; the API research has
   3 concrete questions above).
2. Plan — architect (append §Plan to the spec).
3. Implement — implementer.
4. Test — test-writer.
5. Review — code-reviewer (skip security-auditor per `needsSecurityReview: false`).
6. Document — doc-writer (must run `pnpm fix:readme`).
7. Open PR — `gh pr create`. **Yellow tier: leave open for human review,
   do NOT enable auto-merge.**

## Pause-worthy

- API research surfaces a contradiction (e.g. `/all-tasks` doesn't actually
  accept `projects_ids[]`).
- Architect can't resolve the route-selection ambiguity from open concerns §1.
- Coverage drops below threshold; 2 retries can't restore.
- Stuck retry loop on tests (3 retries, same failure).

## Recommended branch name

`feat/tasks-list`
