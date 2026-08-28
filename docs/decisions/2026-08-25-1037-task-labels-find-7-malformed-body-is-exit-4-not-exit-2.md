# Decision 7 — Malformed response body is exit 4, and the spec was corrected to match

**Run:** 2026-08-25-1037-task-labels-find
**Phase:** test
**Agent:** orchestrator (test-writer mandate)

**Question:** The spec's edge-case table assigned exit **2** to a response body missing the `labels` key. The codebase actually produces exit **4**. Change the code, or change the spec?

**Decision:** Change the spec. Malformed response → `FreeloApiError` with `code: VALIDATION_ERROR`, exit 4.

**Alternatives considered:**

- Make the command catch the schema failure and re-throw `ValidationError` (exit 2) to match the spec as written. Rejected: it would make this one command disagree with every other API-backed command in the CLI, and exit codes are a public contract agents script against. A one-off would be a silent inconsistency.
- Leave the spec wrong and just write the test against exit 4. Rejected: calibration §2 treats exit codes as contract; a spec that misstates one is a trap for the next reader.

**Rationale:** `src/api/client.ts` surfaces response-schema failures as `FreeloApiError`/`VALIDATION_ERROR`/exit 4, and `test/commands/labels/list.test.ts:234-242` asserts exactly that for the sibling command. The distinction is principled: **exit 2 is for input the user controls**, exit 4 for a server-side fault — and a server sending an unparseable body is the latter. The spec's exit-2 row was my own drafting error, caught by writing the test rather than by assuming. Spec §5 now records the corrected code and the reasoning.
