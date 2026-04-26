# Decision 1 — R04 ships without `--with labels`

**Run:** 2026-04-26-0914-r04-projects-show
**Phase:** spec (resume after API-research pause)
**Agent:** orchestrator + architect (with human input via `/resume` answer A)

**Question:** How should R04 handle the roadmap's `--with labels` flag, given that no documented Freelo endpoint exposes per-project labels?

**Decision:** Drop `--with labels` from R04 entirely. Ship `freelo projects show <id>` with `--with workers` only. The `--with` flag plumbing remains so future slices can add values (e.g. R06 tasklist show) without breaking the contract. Roadmap updated to remove `--with labels` from R04 and add a deferral note.

**Alternatives considered:**
- B. `--with labels` calls the workspace-scoped `/project-labels/find-available` endpoint with a clearly renamed envelope key. Rejected: semantic mismatch ("labels on this project" vs. "labels I can use anywhere") creates a high risk of agent misuse.
- C. Discover an undocumented per-project labels endpoint via `--allow-network` probing. Rejected: this run was launched with `--allow-network: false`; would also require tier escalation to Red.
- D. Defer R04 entirely until Freelo adds a per-project labels read API. Rejected: blocks the slice indefinitely on an external party.
- E. Abort the run. Rejected: 95% of R04's value (the project detail view) ships fine without labels.

**Rationale:** Option A from the pause report is the api-specialist's recommendation and the user's chosen resolution. It ships the slice exactly as far as the documented Freelo surface allows, with no hidden mismatches. Per-project label read is tracked as a future R04.5 once Freelo extends the API.
