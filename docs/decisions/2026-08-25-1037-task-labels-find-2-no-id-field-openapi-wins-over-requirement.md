# Decision 2 — Output has no `id` column; the OpenAPI contract overrides the requirement text

**Run:** 2026-08-25-1037-task-labels-find
**Phase:** spec
**Agent:** orchestrator (architect mandate)

**Question:** The requirement and the roadmap slice both describe the command as listing "id/uuid/name/color", but the `TaskLabel` schema has no `id`. Which wins?

**Decision:** Ship `uuid`, `name`, `color` only. No `id` field in the envelope, no `ID` column in the human table.

**Alternatives considered:**

- Emit `id: null` to match the requirement's field list literally. Rejected: baking a permanently-null field into a public envelope schema is worse than omitting it — consumers would code against a field that never carries data.
- Pause and ask. Rejected: `autonomous-sdlc.md` §Failure modes says the Freelo contract is authoritative when a spec disagrees with it, which *is* the resolution. Nothing was ambiguous once the yaml was read.
- Map `uuid` into an `id` field for cross-resource consistency with `freelo labels list`. Rejected: actively misleading — `labels list`'s `id` is a number, this would be a uuid string. Same field name, different type, across two sibling commands.

**Rationale:** `docs/api/freelo-api.yaml:5949-5958` defines `TaskLabel` as exactly `{uuid, name, color}`. Task labels are uuid-keyed; the id-keyed labels are project-labels, a different resource. The requirement's phrasing appears to be carried over from the project-labels shape. The response schema stays `.passthrough()`, so if the live API ever does return an extra field it still reaches `--output json` — it just isn't a documented column. Flagged in the roadmap so M05/M06 don't re-propagate the wrong field list.
