# Decision 9 — Empty `--stdin` input → silent success, exit 0

**Run:** 2026-04-27-tasks-create
**Phase:** spec
**Agent:** orchestrator (acting as architect)

**Question:** What should happen when `--stdin` is set but there are no input lines (or only blanks)?

**Decision:** Emit nothing to stdout, exit 0.

**Alternatives considered:**
- Emit a single sentinel envelope with `notice: "no input lines"`: pollutes NDJSON consumers that pipe through `jq`.
- Exit 2 (treat empty input as a usage error): forces agents to special-case "I generated no work" — common with conditional pipelines.

**Rationale:** NDJSON consumers are happiest with zero output for zero input. The agent that piped empty input knew it had nothing to do.
