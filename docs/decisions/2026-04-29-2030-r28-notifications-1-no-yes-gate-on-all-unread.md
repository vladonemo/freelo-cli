# Decision 1 — `--all-unread` does not require `--yes`

**Run:** 2026-04-29-2030-r28-notifications
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** Should `freelo notifications read --all-unread` require `--yes` (or a TTY confirmation prompt) before bulk-POSTing mark-as-read across the entire unread feed?

**Decision:** No `--yes` gate; no confirmation prompt.

**Alternatives considered:**

- **A. Require `--yes`** — friction on the common drain-my-inbox case; inconsistent with `tasks finish --ids` (R11) which doesn't gate either.
- **B. TTY-only confirmation prompt** — adds a Calibration #7 risk surface (TTY-prompt CI gotcha) for a non-destructive operation.
- **C. No gate (chosen)** — match R11 precedent; the operation is **reversible** via `freelo notifications unread <id>` and changes nothing in workspace state beyond the `is_unread` flag.

**Rationale:** CLAUDE.md defines "destructive ops" as data-loss / hard-to-reverse. Marking notifications as read is reversible by design (the API documents and provides `mark-as-unread` as the inverse). Adding a confirm gate would be friction with no security benefit and inconsistent with the precedent set by `tasks finish --ids 1,2,3,...`. Flagged in PR body for human review.
