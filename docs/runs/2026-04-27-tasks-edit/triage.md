# Triage — R10 `freelo tasks edit <id>`

**Run:** 2026-04-27-tasks-edit
**Tier:** **Yellow**

## Rationale

Yellow because:
- Adds a new user-visible command (`freelo tasks edit`) — additive surface.
- Adds a new envelope schema `freelo.tasks.edit/v1` (additive — no v-bump).
- Adds two new wire endpoints (`POST /task/{id}` and the two label-diff endpoints) — they each get a thin client wrapper, but **no changes** to `src/api/client.ts`, no auth/HTTP-defaults touched.
- Changeset is `minor`.
- No `src/config/`, no auth flow, no TLS/retry change, no exit-code repurposing.
- No new runtime dependencies.
- Reuses the R09 shared write infra (`src/lib/dry-run.ts`, `src/lib/batch.ts`) verbatim.

## Route flags

- `needsSecurityReview`: false — no auth/secrets/config-write surface.
- `requiresFreeloApi`: confirmed against `docs/api/freelo-api.yaml` lines 1690–1762 (edit), 2484–2528 (add labels), 2530–2573 (remove labels). The OpenAPI exposes the verb as **`POST /task/{task_id}`** (the roadmap allows "PATCH … or the spec's edit verb"); use POST.
- `preApprovedDeps`: [] — none needed.

## Red triggers checked (all clear)

- [x] No touch to `src/config/`, `src/api/client.ts`, auth flows.
- [x] No breaking changes (purely additive command + schema).
- [x] No major dep bumps / removals.
- [x] No `major` changeset.
- [x] No spec ambiguity: OpenAPI explicitly documents the partial-update body and the label-diff endpoints.
- [x] Roadmap dep R09 is shipped (commit 514f644).

## Decisions to make autonomously (logged)

1. Edit verb: POST (per OpenAPI), not PATCH (roadmap caveat).
2. Whether to fail when nothing is set vs. allow a no-op (decide: fail with `VALIDATION_ERROR` — agents calling `edit` with no flags is almost always a bug).
3. Label diff order: add-then-remove vs. remove-then-add (decide: remove first, then add — matches Freelo's documented "set" semantics; minimizes the `task_labels_change` event flicker).
4. Worker change: send a single `worker` (per OpenAPI) — same first-only-with-notice convention as create.
5. Tracking-users — out of scope for v1 (roadmap is silent on it; spec OpenAPI exposes it but R10 says "name, due date, workers, priority, labels" only).
6. `--clear-priority` / `--clear-due` — explicit nullable flags so `null` is differentiable from "not set". Decide: add only `--clear-priority` (priority_enum is documented nullable). Skip `--clear-due` for v1 (no clean OpenAPI signal that empty string clears it).
7. Envelope shape: `task` (TaskDetail returned by edit) + `tasklist_id`/`project_id` echoed similar to create. Add `applied_changes` echo of the diff request the CLI sent.

## Budget snapshot

- Defaults: 30m / 40 calls / 8 retries / 25 files
- Pre-flight at: 0 calls used.
