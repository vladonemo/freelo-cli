# Decision 2 — `--with workers` calls the paginated `/project/{id}/workers` endpoint

**Run:** 2026-04-26-0914-r04-projects-show
**Phase:** spec
**Agent:** architect (with human pre-decision via `/resume` answer)

**Question:** Should `--with workers` (a) call the paginated `GET /project/{id}/workers` endpoint and merge all pages, or (b) project the embedded `workers` array already returned by `GET /project/{id}` (which is `ProjectDetail.workers`)?

**Decision:** Use option (a) — the paginated `/project/{id}/workers` endpoint. The command issues one `GET /project/{id}` (always) and then, when `--with workers` is set, iterates `?p=0, 1, …` until the normalized cursor returns null. Reuses R03's `normalizePaginated` and `fetchAllPages` helpers with `innerKey: 'workers'` and `itemSchema: UserBasicSchema`.

**Alternatives considered:**
- (b) Project `data.project.workers` from the single `/project/{id}` call. Cheaper (one round-trip vs. N+1), but the inline list is capped at the server's undocumented inline limit. Risks truncated results without surfacing that fact to the agent.

**Rationale:**
1. The roadmap (line 121) explicitly lists `GET /project/{id}/workers` alongside `GET /project/{id}` as the two endpoints for R04. Honoring it preserves the slice's stated contract.
2. The paginated endpoint reuses R03's pagination plumbing — zero new pagination code.
3. The full paginated list is unconditionally complete; the embedded inline list may be silently truncated. Agents asking for "the workers" expect "all of them, please."

The cheaper alternative (b) is recorded in the spec §7 OQ#1 as a future optimization if performance becomes a concern. The richer embedded data (each worker's `hour_rate`) remains available via `data.project.workers` regardless, since `data.project` is the full `ProjectDetail`.
