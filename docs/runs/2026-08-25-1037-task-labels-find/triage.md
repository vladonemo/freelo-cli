# Triage — 2026-08-25-1037-task-labels-find

**Tier:** Yellow
**Commit type:** feat

## Summary

Add `freelo task-labels find [--project <id>]`, a new read-only leaf on the existing `task-labels` parent command (R24, spec 0036). It wraps the newly documented `GET /task-labels/find-available` and lists every task label usable by the caller (uuid/name/color), optionally scoped to a single project via `?project_id=`. This closes the "no bulk-list / name→uuid resolver for task-labels" gap that `.claude/skills/freelo-api/SKILL.md` has carried in Known quirks since R24.

## Signals

- [x] Touches src/commands/ (new/changed subcommand)
- [ ] Touches src/config/
- [ ] Touches src/api/client.ts or HTTP defaults
- [ ] Touches auth flows
- [ ] Adds a dependency
- [ ] Removes a dependency
- [x] Changes an envelope schema (`freelo.*/vN`) — **new** schema `freelo.task_labels.find/v1`; no existing schema touched
- [ ] Changes exit codes
- [ ] Removes/renames an existing flag
- [x] Requires the Freelo API
- [ ] Docs-only

## Route flags

- requiresFreeloApi: true
- needsSecurityReview: false
- preApprovedDeps: []
- allowNewDeps: false

## Rationale

Yellow, not Green. Three independent Yellow triggers from `autonomous-sdlc.md` §Risk tiers fire: (1) **new user-visible command** (`task-labels find`) and a **new user-visible flag** (`--project`), both additive; (2) a **new envelope schema** `freelo.task_labels.find/v1` enters the public contract — `CLAUDE.md` states envelope schemas *are* a public contract, so minting one is a contract addition even though nothing existing is touched; (3) the changeset will be **`minor`**, which is itself an explicit Yellow trigger.

The roadmap slice's "Green candidate" guess leaned on the Green *example* list ("new read-only subcommand"). That example conflicts with the explicit Yellow trigger "New user-visible command or flag (additive)", and §Risk tiers says **highest tier wins** when signals conflict. Read-only-ness and the absence of writes/destructive ops correctly keep this *out* of Red — they do not pull it down to Green. This matches how the two sibling runs today (M01 `comments delete`, M08 `tasks list --order-by`) landed.

No Red trigger fires: nothing in `src/config/`, no auth flow, no `src/api/client.ts` change (the existing `buildQuery` + path-composition convention covers the one query param), no dependency change, no breaking change, and the requirement's scope and UX are unambiguous.

## Open concerns

For the architect to resolve in the spec:

1. **Field list discrepancy — requirement vs. OpenAPI.** The requirement (and the roadmap slice) say the command lists "id/uuid/name/color". The authoritative `TaskLabel` schema at `docs/api/freelo-api.yaml:5949-5958` has only **`uuid`, `name`, `color` — there is no `id`**. Task labels are uuid-keyed; project labels are the id-keyed ones. Follow the OpenAPI contract, do not invent an `id` column. Log as a decision.
2. **Do not model this on `freelo labels list`'s deferral.** R23 deferred its `--project` flag (spec 0035 decision 03) because `/project-labels/find-available` accepts no query parameters. The new `/task-labels/find-available` **does** document `project_id` (yaml:2858-2864), so `--project` ships here in v1. Different endpoint, opposite conclusion.
3. **Empty result is a success, not an error.** Both documented empty cases (inaccessible/unknown `project_id`; caller has no accessible projects) return `{ "labels": [] }` with HTTP 200. Must render as an empty list and exit 0 — no synthesised 404, no `FreeloApiError`. Needs explicit test coverage on both arms.
4. **SKILL.md quirk note.** The existing Known-quirks entry about `find-available` returning empty results refers to the *project-labels* endpoint. Any SKILL.md update in the document phase must retire the "no bulk-list for task-labels" quirk without corrupting the project-labels note.
5. **Spec number collision.** Both open sibling PRs (#113, #114) independently claimed `docs/specs/0061-*.md`. This run must not take `0061`.

## Recommended branch name

`feat/task-labels-find`

---

```
TRIAGE run=2026-08-25-1037-task-labels-find tier=Yellow type=feat flags=[requiresFreeloApi]
```
