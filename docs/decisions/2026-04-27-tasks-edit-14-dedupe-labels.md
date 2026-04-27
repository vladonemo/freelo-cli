# Decision 14 — Dedupe `--add-label` / `--remove-label` repeats case-sensitively

**Run:** 2026-04-27-tasks-edit
**Phase:** Spec / Implement
**Agent:** implementer

**Question:** What does `--add-label urgent --add-label urgent` do? `--add-label foo --add-label Foo`?

**Decision:** Dedupe case-sensitively, preserve first-seen order. Send each unique name once.

**Alternatives considered:**
- Send duplicates as-is (let the server decide).
- Dedupe case-insensitively.
- Reject duplicates with `VALIDATION_ERROR`.
- Dedupe case-sensitively (chosen).

**Rationale:** Freelo treats `"foo"` and `"Foo"` as distinct labels (OpenAPI :2501). Case-insensitive dedupe would be lossy. Sending duplicates wastes bytes; rejecting on duplicates is over-strict (users might generate them programmatically).
