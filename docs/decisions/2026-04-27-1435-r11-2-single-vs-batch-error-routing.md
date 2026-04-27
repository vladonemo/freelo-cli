# Decision 2 — Single-id mode bubbles errors to stderr; multi-id mode streams per-id errors to stdout

**Run:** 2026-04-27-1435-r11-tasks-finish-reopen
**Phase:** implement
**Agent:** orchestrator (Opus 4.7)

**Question:** When a single positional id fails (e.g. `freelo tasks finish 9012` returns 403), should the error envelope go to stdout (per-id batch shape, alongside successes) or to stderr (single-mode shape, via the top-level handler)?

**Decision:** Single-id mode (one positional id and no `--ids`/`--stdin`) bubbles errors to the top-level handler — the standard `freelo.error/v1` envelope on stderr, exit code on the process. Multi-id mode (more than one id from any source, OR `--stdin`) keeps per-id error envelopes on stdout and accumulates the highest exit code at end-of-stream.

**Alternatives considered:**
- Always emit per-id error envelopes on stdout, even in single-id mode. Rejected: this contradicts R09/R10's single-mode shape (error envelope on stderr) and would surprise agents that already key off the convention.
- Always bubble errors to stderr, even in batch. Rejected: defeats the purpose of NDJSON streaming and would lose per-line context.

**Rationale:** R09 and R10 both treat single-id (or single-write) failures as stderr emissions through `handleTopLevelError`. R11's single-id call surface (`freelo tasks finish 9012`) is shaped exactly like a single-write command — agents calling it expect single-write error semantics. Batch mode (`--stdin`, multi-positional, `--ids`) is the explicit opt-in to streaming semantics, so per-id errors there go on stdout interleaved with successes.

This decision was driven by test feedback: the initial implementation routed every per-id error via the batch writer (writing to stdout), but the test "POST 403 → FORBIDDEN exit 4" expected the standard stderr envelope. Aligning with R09/R10 made all 43 tests pass without contortion.
