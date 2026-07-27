# Decision 3 — Relax `FileBasicSchema.uuid` alongside `id`, not `id` alone

**Run:** 2026-07-27-1211-tasks-edit-validation
**Phase:** Plan
**Agent:** orchestrator (architect mandate)

**Question:** The live repro proves only `FileBasicSchema.id` blocks parsing — exactly
one zod issue was reported for that object, so `uuid` was present and valid. Should the
fix relax `id` alone (minimum proven) or `id` and `uuid` (matching the siblings)?

**Decision:** Relax both to `.nullable().optional()`.

**Alternatives considered:**

- **Relax `id` only.** Minimum change, strictly evidence-bounded. Rejected: it fixes one
  instance of the class and leaves the identical trap on `uuid`. The next task whose
  file DTO omits `uuid` reproduces the same crash, and we would have had the evidence in
  hand and declined to act on it.
- **Relax both (chosen).**
- **Replace with `z.unknown()` / drop the schema.** Explicitly ruled out by the resume
  brief and by CLAUDE.md ("every network call is schema-validated"). Fields still
  validate when present.

**Rationale:** The module's own stated convention (`src/api/schemas/task.ts:10-12`) is
that only universally-present fields are required and everything else is
`.nullable().optional()`; nothing in the repro says either identifier is universally
present. Both sibling file-ref schemas written later — `FileFullRefSchema`
(`src/api/schemas/comment.ts:62-66`) and `NoteFileRefSchema`
(`src/api/schemas/note.ts:38-42`) — already model exactly this, with `uuid` optional and
no `id` at all. `FileFullRefSchema` occupies the same position (rich file object
embedded in a comment), which makes it a direct precedent rather than an analogy.
`FileBasicSchema` is the outlier, and the cost of alignment is zero: `.passthrough()`
means a present `uuid` still reaches the envelope, and the type check still fires on a
wrong-typed one.
