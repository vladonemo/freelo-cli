# Decision 3 — Interleave NDJSON parse + run so output order matches input

**Run:** 2026-04-27-1435-r11-tasks-finish-reopen
**Phase:** implement
**Agent:** orchestrator (Opus 4.7)

**Question:** Parse all NDJSON lines first then run the valid ones in a second loop, OR interleave parse-then-run per line?

**Decision:** Interleave per line (parse → run → emit envelope, then the next line).

**Alternatives considered:**
- Parse-first, run-second (the initial draft). It's simpler — and for a homogenous stream of valid lines, equivalent. Rejected because it reordered stdout: any per-line parse error was emitted before all subsequent successes regardless of input position. Agents reading the NDJSON stream and trying to align with their input lost positional context.

**Rationale:** Spec 0021 §3.2 promises one envelope per input line "as the line completes (streamed, not buffered)". The parse-first approach buffered errors and successes into separate phases, which violated that contract even though the `line_index` was correct. Interleave keeps stdout monotonically aligned with stdin's positional index — agents pipelining `tasks list | jq | tasks finish --stdin` see envelope N corresponding to input N.
