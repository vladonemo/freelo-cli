# Phase 6 — Document

| Artifact | Change |
|---|---|
| `docs/commands/task-labels-find.md` | **new** — synopsis, options, ordering, the empty-result section, permissions, envelope table, four examples, exit codes, see-also. |
| `README.md` | Autogen Commands block regenerated with `pnpm fix:readme` (after `pnpm build`, since the script introspects `dist/freelo.js`). One line added. Never hand-edited. |
| `.claude/skills/freelo-api/SKILL.md` | Known-quirks entry rewritten (see below). |
| `docs/roadmap-migration-2026-08.md` | M04 marked shipped, mirroring the convention PR #113 established for M01. |
| `.changeset/lucky-moons-search.md` | `minor`, with a dedicated line naming the new envelope schema per `CLAUDE.md`. |

## SKILL.md — surgical, not wholesale

The quirk entry at :179 covers **both** label resources, and only the task-labels half is now obsolete. The edit:

- **Keeps** the project-labels finding intact — `GET /project-labels/find-available` returning `{"labels":[]}` despite populated inline task labels is still true and still worth knowing.
- **Retires** the task-labels half, replacing the two round-trip workarounds (scan `/all-tasks`; round-trip via `add-to-task`) with a pointer to the real endpoint, marked shipped rather than "once M04 ships".
- **Adds** an explicit don't-conflate-these note (uuid-keyed vs. id-keyed; accepts `project_id` vs. accepts no query params), since the requirement flagged this confusion as the top risk in the slice.
- **Adds** the empty-is-not-an-error semantics, so a future agent doesn't "fix" it into a 404.

## Doc emphasis

The user doc leads with the resolver workflow (`find` → `jq` → `attach --uuid`) because that's the concrete reason the command exists, and gives the empty-result ambiguity its own section rather than burying it in a table — it's the one behavior most likely to be misread as a bug. The `labels list` distinction is called out in a blockquote at the top and again in see-also.
