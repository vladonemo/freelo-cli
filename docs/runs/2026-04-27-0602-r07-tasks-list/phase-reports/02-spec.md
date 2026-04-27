# Phase 2 — Spec

**Spec:** `docs/specs/0017-tasks-list.md` (sections 1-7).
**Open questions:** 12, all with binding recommendations.
**New deps:** 0.

## Key design decisions

1. **Two routes in v1, not three.** OQ #4 — the `/tasklist/{id}/finished-tasks` route is deferred to R07.5 because routing to it unambiguously requires either an explicit `--finished` flag or a `freelo states list` command (neither in scope). The CLI surface still registers the `--finished-*` flags; they always force `/all-tasks` (which supports them).
2. **Two discriminators in the envelope.** `data.endpoint` (where did we route?) + `data.entity_shape` (what fields per item?). 1-1 today, but separate so a future Freelo change to one endpoint doesn't break the schema.
3. **`with_label` (singular, deprecated) is never emitted.** CLI surface is `--label <name>` (repeatable) → `with_labels[]=` always. Resolves the merge quirk by side-stepping it.
4. **`buildQuery` is a new `src/lib/query.ts` shared lib.** Roadmap requirement; small (~50 LOC); test surface is one file. Future write commands reuse it.
5. **Default `--fields` per entity-shape (not per command).** R07 has three shapes; each gets its own registry. Validation runs after route resolution.

## Phase report

```
ARCHITECT phase=spec run=2026-04-27-0602-r07-tasks-list status=ok spec=docs/specs/0017-tasks-list.md open_questions=12 new_deps=0
```
