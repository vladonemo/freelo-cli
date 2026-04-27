# Triage — R08 `freelo tasks show <id>`

**Run:** 2026-04-27-0535-tasks-show
**Tier:** Yellow
**Branch:** `feat/tasks-show`

## Rationale

Read-only additive command. The orchestrator invocation flagged "expected
Green" but the autonomous-sdlc.md Yellow trigger list explicitly includes:

> New user-visible command or flag (additive)
> New field added to an envelope schema (backwards-compatible)
> Changeset is `minor`

All three fire for R08. The two structurally identical predecessors (R04
`projects show` spec 0013, R06 `tasklists show` spec 0016) were both tagged
Yellow for the same reasons; we follow that precedent.

No Green/Red mixing — the change does not touch:

- `src/config/`, auth flows, `src/api/client.ts`
- TLS / retry / redirect defaults
- Existing envelope schemas (no `/v(n+1)` bump on any existing schema)
- Exit codes, flag names
- Release tooling

## Route flags

- `needsSecurityReview`: **false** — no auth, no config, no secrets handling.
- `requiresFreeloApi`: **true** — the `--with projects` side-car needs an
  API decision because `GET /task/{task_id}/projects` is documented in the
  roadmap but **not** in the OpenAPI spec (only `POST` and `DELETE` exist
  on that path). The equivalent data is embedded in `TaskDetail.multi_project_task`
  per the OpenAPI description (`docs/api/freelo-api.yaml:1676`). The
  architect's decision: surface the embedded block under
  `data.projects` when `--with projects` is requested. Logged as
  decision 1 below.
- `preApprovedDeps`: **[]** — no new runtime deps allowed.

## Risk-tier flow

- Full pipeline runs.
- PR opens with auto-merge **disabled**.
- Stops at PR-open (Yellow gate). Human reviews + merges.
- No `/ship` invocation; autoShip is false anyway.

## Budget caps in effect

| Resource | Cap |
|---|---|
| Wall clock | 30 min |
| Agent invocations | 40 |
| Phase retries (cumulative) | 8 |
| Files touched | 25 |

## Initial decisions to log during spec

1. **`--with projects` data source** — `GET /task/{id}/projects` is
   not documented in the OpenAPI. `TaskDetail` already embeds a
   `multi_project_task` block (OpenAPI :1676). v1 surfaces that block
   under `data.projects` when `--with projects` is set. No second HTTP
   call; the side-car is a projection over the already-fetched detail.
   The roadmap line is updated to reflect this in the spec PR.
2. **`--with description`** — `GET /task/{id}/description` returns a
   `Comment` shape. One extra HTTP call, parallel pattern to R04 workers
   side-car (just unpaginated — the description is a single object).
3. **`--with subtasks`** — `GET /task/{id}/subtasks` is paginated
   (inner key `subtasks`). Pattern mirrors R04 workers exactly: client
   walks all pages, merges into one `data.subtasks` array.
