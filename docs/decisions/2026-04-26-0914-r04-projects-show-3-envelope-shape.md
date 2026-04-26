# Decision 3 — Envelope shape `freelo.projects.show/v1` uses `data.project` + optional `data.workers`

**Run:** 2026-04-26-0914-r04-projects-show
**Phase:** spec
**Agent:** architect

**Question:** What is the shape of `data` in the `freelo.projects.show/v1` envelope?

**Decision:** `data: { project: ProjectDetail, workers?: UserBasic[] }`. `data.project` is always present. `data.workers` is **only present** when `--with workers` was passed; absent (not `null`, not `[]`) otherwise. No top-level `paging` field.

**Alternatives considered:**
- Bare `data: ProjectDetail` (no wrapping object). Rejected: leaves no place to attach the optional workers side-car without polluting the entity itself.
- Always emit `data.workers` as `[]` when `--with workers` was not passed. Rejected: indistinguishable from "no workers exist". Presence-based signalling is clearer for agents.
- Always emit `data.workers` as `null` when not requested. Rejected: forces every consumer into a `if (workers !== null)` branch where absence already conveys the same information.

**Rationale:** The presence/absence convention matches the agent-first contract: agents key off whether the field exists. R03 uses an analogous pattern (`paging.next_cursor` is `null` only on the last page; absent fields stay absent in projection mode). Wrapping `data` in an object also leaves room for additional side-cars (future `--with` values) without an envelope version bump.
