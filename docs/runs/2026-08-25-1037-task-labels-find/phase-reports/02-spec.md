# Phase 2 — Spec

**Artifact:** `docs/specs/0062-m04-task-labels-find.md` (~200 lines, incl. the appended `## Plan`).
**Open questions:** none → no pause.

## Endpoint verified against the cached contract

Read `docs/api/freelo-api.yaml:2841-2876` (`operationId: findAvailableTaskLabels`) directly rather than trusting the roadmap paraphrase. All three roadmap behavior claims confirmed verbatim: sorted by `name` ascending; `project_id` optional query param, inaccessible project → `{"labels":[]}`; no accessible projects → `{"labels":[]}`.

## Triage concerns resolved

1. **`id` field doesn't exist.** `TaskLabel` (yaml:5949-5958) is exactly `{uuid, name, color}`. The requirement's "id/uuid/name/color" is wrong — carried over from the id-keyed project-labels shape. OpenAPI is authoritative → decision 2. Flagged in the roadmap so M05/M06 don't inherit the error.
2. **`--project` ships in v1**, unlike R23's deferral (spec 0035 decision 03). That deferral was because `/project-labels/find-available` accepts *no* query params; this endpoint documents `project_id`. Opposite endpoint, opposite conclusion.
3. **Empty = success** locked into §5 and the test plan → decision 4.
4. **SKILL.md** update scoped to retiring only the task-labels half of the quirk.
5. **Spec numbered 0062**, dodging the `0061` both sibling PRs claimed → decision 8.

## Also checked

Read `src/commands/task-labels/attach.ts` and `buildAddTaskLabelsBody` to answer the roadmap's "revisit attach's `--name` round-trip workaround, if one exists" follow-up. **It doesn't exist** — `attach` passes name-mode entries straight through and lets the server fetch-or-create. Nothing to un-hack → decision 5, recorded in the roadmap so it isn't re-opened on a false premise.

Modelled the command on `src/commands/labels/list.ts` (read-only flow, `renderAsync`, envelope) and `attach.ts` (flag-parser shape, `ValidationError`), per the requirement's instruction to match existing `task-labels` conventions.
