# Decision 1 — `help` subcommand wiring (no clobber of Commander built-in help)

**Run:** 2026-04-25-1405-introspect
**Phase:** Spec
**Agent:** orchestrator

**Question:** Should `freelo help --output json` (and `freelo help <cmd> --output json`) hijack Commander's built-in help, or be a new `help` subcommand that exists alongside it?

**Decision:** **New `help` subcommand**. Register a Commander subcommand named `help` with optional positional `[command]` and the global `--output` flag inherited. When `--output json` (or non-TTY auto), emit the introspect envelope (full or scoped). When `--output human` (or TTY auto), delegate to Commander's built-in `outputHelp()` on the resolved program/subcommand — same text Commander would have written for `freelo --help` / `freelo <cmd> --help`. The global `-h, --help` flag stays untouched.

**Alternatives considered:**
- Override Commander's `program.helpCommand(false)` and rebuild help. Rejected: this rewrites existing help-text behavior with no user benefit and risks breakage in CI scripts that already parse `freelo --help`.
- Skip the `help` alias and only ship `--introspect`. Rejected: contradicts roadmap §R02.5 explicit alias requirement.

**Rationale:** The roadmap calls `help --output json` an "agent-friendly alias", not a replacement of help. A new subcommand is purely additive — `freelo --help` and `freelo <cmd> --help` are unchanged. No pause needed: this is a clean additive UX choice, not a breaking change to existing behavior.
