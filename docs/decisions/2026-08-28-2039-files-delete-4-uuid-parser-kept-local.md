# Decision 4 — UUID validator duplicated locally rather than extracted to `src/lib/`

**Run:** 2026-08-28-2039-files-delete
**Phase:** plan
**Agent:** orchestrator (executing the `architect` mandate)

**Question:** `src/commands/files/download.ts` :52 already has a strict 8-4-4-4-12 `UUID_REGEX` and a
`validateUuid` throwing `ValidationError`. Extract it to a shared `src/lib/uuid.ts` and refactor R27 to
consume it, or re-declare it in the new command file?

**Decision:** Re-declare it locally in `src/commands/files/delete.ts`, with a comment naming the R27 copy
and the reason. `download.ts` is left untouched.

**Alternatives considered:**

- **Extract `src/lib/uuid.ts`, refactor `download.ts` to use it.** More DRY, and tempting. Rejected:
  it modifies a shipped command purely for tidiness, widens the diff of a destructive-command slice into
  an unrelated one, and risks perturbing R27's exact error copy, which its tests assert.
- **Import R27's regex directly from `download.ts`.** Rejected — that would make a delete command import
  a module whose top level pulls in `node:fs/promises`, `node:crypto` and a spinner path, for one regex.

**Rationale:** The codebase's established habit is to keep tiny input parsers local to the command file:
`src/commands/comments/delete.ts` re-declares `parsePositiveInt` beside R13's copy rather than sharing it.
Following the local precedent keeps this slice's diff confined to new files plus two additive edits.
Extraction remains an easy, safe follow-up if a third UUID-taking command appears — at which point it
would be a refactor slice of its own, with its own tests, rather than a rider on a destructive feature.
