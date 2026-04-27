# Decision 5 — `--description-file` rejected in `--stdin` batch mode

**Run:** 2026-04-27-tasks-create
**Phase:** spec
**Agent:** orchestrator (acting as architect)

**Question:** Should NDJSON batch lines support a `description_file` field (per-line file path)?

**Decision:** No. In batch mode, the `description` field carries inline text only. `--description-file` is single-mode-only.

**Alternatives considered:**
- Per-line `description_file`: lets generators reuse on-disk files. Path-traversal risk; requires per-line file access checks, error mapping per line.
- Drop `--description-file` entirely: loses a useful single-mode ergonomic.

**Rationale:** Path inputs in NDJSON are an attack surface (an agent emitting lines could be tricked into reading arbitrary files). Agents who need file-driven inputs can pre-resolve to inline `description` text. Single-mode keeps `--description-file` because there's already a UID/process boundary.
