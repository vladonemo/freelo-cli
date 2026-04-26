# Decision 1 — Use `/all-tasklists?projects_ids[]=<id>` for the per-project mode

**Run:** 2026-04-26-1537-r05-tasklists-list
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** The roadmap names `GET /project/{project_id}/tasklists`, but the OpenAPI spec only documents `POST` on that path. How should the per-project listing be implemented?

**Decision:** Use `GET /all-tasklists?projects_ids[]=<id>` for the per-project mode. Single endpoint backs both `--project <id>` and the no-flag default. No discriminator needed (one entity shape).

**Alternatives considered:**
- Pause and ask the human to confirm whether an undocumented `GET /project/{id}/tasklists` exists. Cost: budget burn + agent rate-limit risk. Roadmap entries have been authoritative-but-imprecise before; pausing on every "the roadmap mentions an undocumented endpoint" would block too much.
- Try the undocumented path optimistically, fall back to `/all-tasklists` on 404. Cost: unobservable complexity, two HTTP calls in the bad case, and a contract built on undocumented behavior — exactly what `.claude/docs/autonomous-sdlc.md` "Never guess API behavior" forbids.

**Rationale:**
1. `/all-tasklists?projects_ids[]=<id>` is fully documented (`docs/api/freelo-api.yaml:1180-1233`).
2. ACL filtering (`:1193-1194`) ensures per-project visibility matches what a hypothetical `/project/{id}/tasklists` would have shown.
3. Returns the same `TasklistFull` entity in both modes — eliminates the need for an `entity_shape` discriminator (simpler envelope than R03).
4. If the undocumented endpoint exists with materially different semantics, R05.5 can add it without a v2 bump (envelope `data` shape is forward-compatible).
5. Captured as Open Question #1 in `docs/specs/0014-tasklists-list.md` so the human can override at the spec-review gate.

**Audit:** This is a load-bearing decision; the spec, plan, implementation, and tests all assume `/all-tasklists` is the only endpoint. If the human overrides, the entire spec is reworked.
