## Paused at phase 2 (spec — API research)

**Run:** 2026-04-26-0914-r04-projects-show
**Reason:** Roadmap calls for `--with labels` but the OpenAPI spec has no per-project labels read endpoint and `ProjectDetail` does not embed labels. Per orchestrator brief this is the explicit pause-worthy condition: "API research surfaces something materially different from the roadmap (e.g., labels need a separate undocumented endpoint…)".
**Risk tier:** Yellow (escalation candidate to **Red** if the chosen option is "extend the OpenAPI" or "make a real API probe to discover an undocumented endpoint")

### What happened

`freelo-api-specialist` (api-research role) reviewed `docs/api/freelo-api.yaml` for the two endpoints listed in the R04 roadmap entry plus the labels surface:

1. `GET /project/{id}` returns `ProjectDetail` (lines 530-556 / schema 4969-5024) — extends `ProjectFull` with embedded `tasklists` (each with embedded tasks) and embedded `workers` (each with `hour_rate`). **It does NOT embed a `labels` array.** Confirmed by re-reading the schema definition end-to-end.
2. `GET /project/{id}/workers` (lines 583-619) is a standard `PaginatedResponse` with inner key `workers` and `UserBasic[]` items (`{ id, fullname }`). No surprises. Reuses R03's `normalizePaginated`.
3. **Labels — there is no read API for "labels on a project":**
   - No `GET /project/{id}/labels` exists in the spec.
   - No `GET /project-labels?project_id=N` filter exists.
   - `ProjectDetail` does not embed a `labels` array.
   - The only labels read endpoint is `GET /project-labels/find-available` (lines 833-859) which returns **workspace-scoped** labels (everything the caller can assign **anywhere**), not project-scoped labels. Semantic mismatch with the roadmap's intent.
   - Other label endpoints (`/project-labels/{labelId}`, `/project-labels/add-to-project/{projectId}`, `/project-labels/remove-from-project/{projectId}`) are write-only.

The roadmap's `--with labels` cannot be implemented from the documented Freelo surface.

### Evidence

- `docs/api/freelo-api.yaml:530-556` — `getProject` returns `ProjectDetail`; no `labels` field.
- `docs/api/freelo-api.yaml:4969-5024` — `ProjectDetail` schema; embeds `tasklists` and `workers`, no `labels`.
- `docs/api/freelo-api.yaml:583-619` — `getProjectWorkers` paginated, inner key `workers`.
- `docs/api/freelo-api.yaml:832-1036` — full Project Labels block; only `/project-labels/find-available` is a read, and it is workspace-scoped (description :838-839).
- Full research notes: `docs/runs/2026-04-26-0914-r04-projects-show/phase-reports/02-api-research.md`.

### Decision needed

How should R04 handle `--with labels`?

Options:

  A. **Drop `--with labels` from R04.** Ship `freelo projects show <id> [--with workers]` only. Update `docs/roadmap.md:119-123` to reflect reality. Capture "labels read API blocked on Freelo" as a non-goal in the spec and as R04.5 in the roadmap. **Recommended by the api-specialist** — simplest, ships the slice as far as the API actually allows, no hidden surprises for agents.

  B. **`--with labels` calls `/project-labels/find-available`** and emits the **workspace-scoped** label set under a clearly-renamed envelope key (e.g. `available_labels` instead of `labels`). Documents the mismatch in `--help`. Pros: gives the agent something label-shaped. Cons: semantics differ from "this project's labels", which is what `freelo projects show <id> --with labels` will read like to humans and to most agents. High risk of misuse.

  C. **`--with labels` enabled with a real-API probe.** Spawn `freelo-api-specialist` with `--allow-network` to discover an undocumented per-project labels endpoint. Off-policy: this run's flags say `--allow-network: false` and the orchestrator brief is explicit about MSW-only. Would require a tier escalation to Red and a separate authorization.

  D. **Defer R04 entirely** until Freelo adds a documented per-project labels read API. Indefinite pause.

  E. **Abort the run** — pick a different R-slice instead.

### Resume with

`/resume 2026-04-26-0914-r04-projects-show <A|B|C|D|E or free-form answer>`

### Notes for whichever option wins

- **Option A** is fully scoped: spec narrows `--with` to `workers` only; envelope is `freelo.projects.show/v1` with `data: { project, workers? }`; everything else from the orchestrator brief stands.
- **Option A** also lets the architect choose whether `--with workers` exposes the **embedded** workers from `ProjectDetail` (one round-trip) or the **paginated** `/project/{id}/workers` (full list, multiple round-trips). Recommendation when option A lands: paginated, because the roadmap explicitly listed `/project/{id}/workers` as an endpoint.
- **Option B** needs an envelope-naming choice (`available_labels` vs `labels`) and a `--help` warning. Architect's call once unpaused.
- **Option C** would re-tier to Red and require explicit `--allow-network` authorization plus a test account.

No code, fixtures, or commits exist yet. Branch `feat/projects-show` is in place at `origin/main` (`17a7c72`); no work to roll back.
