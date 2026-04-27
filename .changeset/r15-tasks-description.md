---
'freelo-cli': minor
---

R15 — `freelo tasks description` (get/set). Two new commands under a new
nested `tasks description` subcommand:

- `freelo tasks description get <id>` — print the rich-text description (the
  canonical body of a task). Reuses R08's `getTaskDescription` wire wrapper
  and `TaskCommentSchema`.
- `freelo tasks description set <id> (--from-file <path> | --editor | -)
  [--dry-run]` — replace the description (upsert; first call creates,
  subsequent call overwrites entirely with no history per the Freelo API
  contract). Content comes from one of three input sources, each mediated by
  the new shared `src/lib/input.ts` helper.

**First introduction of the `src/lib/input.ts` helper** (per
`docs/roadmap.md:686`). Generic and reusable: `readInput({ kind: 'file' |
'stdin' | 'editor', ... }) → { content, source }`. Future write commands
(R17 `comments add`, R22 `reports edit`, etc.) will reuse the same input
shape. Editor resolution: `$VISUAL` → `$EDITOR` → platform default
(`notepad.exe` on win32, `vi` elsewhere); `--editor` is TTY-only and errors
out cleanly in agent / CI environments.

**Empty content is rejected at the command layer.** A successful `set` with
empty content would silently clear the description — almost always a
destructive accident. The command surfaces a `VALIDATION_ERROR` (exit 2)
and points at `freelo tasks edit <id> --description ''` (R10) for the
explicit clearing path.

**Two new envelope schemas (additive surface):**

- `freelo.tasks.description.get/v1` — `{ task_id, description: Comment }`.
  `description.id` / `.content` may be `null` on tasks with no description
  set (the API returns 200 with empty fields per OpenAPI :2015).
- `freelo.tasks.description.set/v1` — `{ task_id, description?, source?,
  byte_length, would? }`. `description` and `source` are always present in
  live envelopes and absent in `--dry-run`. `byte_length` is always
  present so agents can verify content size against their source.

`set` is **`destructive: false`** — same precedent as R10 (`tasks edit
--description`). `--dry-run` is the safety net for upsert-class writes.

No new runtime dependencies. The new wire wrapper (`setTaskDescription` in
`src/api/tasks-description.ts`) reuses the existing `TaskCommentSchema`
from R08; only the POST wrapper, the input helper, and CLI envelope-data
schemas land in this slice. No `--files` / multipart support in v1 (R25
multipart helper).
