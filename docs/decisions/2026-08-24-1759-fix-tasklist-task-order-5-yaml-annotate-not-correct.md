# Decision 5 — Annotate `freelo-api.yaml`'s `order_by`, don't "correct" it

**Run:** 2026-08-24-1759-fix-tasklist-task-order
**Phase:** 8 — Document
**Agent:** doc-writer (executed inline by orchestrator)

**Question:** Plan TODO-3 was written for hypotheses H1/H4 — "correct `default:` to the empirically
observed value". The experiment found the documented default already correct. What, then, does the
cached contract get?

**Decision:** Leave `default: priority` and the enum byte-for-byte as they are. Add the missing
`description:` to the `order_by` parameter recording that `priority` means the tasklist's manual /
drag-and-drop board order and explicitly **not** the L/M/H `priority_enum` that `POST /task/{id}`
takes, plus the verification date and the issue reference. Add a one-line `description:` to `order`
for symmetry. No other part of the file is touched.

**Alternatives considered:**

- Leave the YAML alone entirely (spec §10's original non-goal). The non-goal existed because editing
  on suspicion would destroy the record of what Freelo claims — but that reasoning is void once the
  claim is confirmed rather than doubted.
- Also declare a positional field on `TaskSummary`. Rejected: no such field was observed, and
  inventing one is exactly the API-guessing this run must not do.
- Record the raw responses as a fixture under `test/fixtures/` (spec §11's closing suggestion).
  Rejected: the MSW suite asserts request shape only (§5.2), so a response fixture would have no
  consumer, and committing captured account data — even disposable template content — is a
  gratuitous data-handling risk for zero test value.

**Rationale:** The gap this run actually closed was semantic, not factual: the upstream spec
documents the value but never says what it sorts by, and the name collides with an unrelated task
field. That ambiguity is what made #108 unresolvable offline in the first place, and the next reader
of this repo — human or agent — should not have to re-run the experiment to learn the answer.
