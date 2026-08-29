# Decision 3 — Drift is reported as data, not as a non-zero exit code

**Run:** 2026-08-29-1750-m05-task-label-colors
**Phase:** spec
**Agent:** orchestrator (architect mandate)

**Question:** When the local `--palette` table disagrees with the server, should the command exit non-zero (or gain a `--check` flag that does)?

**Decision:** No. Exit is 0 whether or not the tables agree. The comparison lives in `data.drift` (`matches`, `server_only`, `local_only`) and human output appends a footer only when they disagree.

**Alternatives considered:**

- Exit non-zero on drift. Rejected: drift is informational, not a failure of the command; a caller asking "what does the server accept" got a correct answer.
- Add `--check` that exits non-zero, leaving the bare command at 0. Rejected: a new exit-code contract is a public surface with a maintenance cost, and it duplicates what one `jq -e` already does.

**Rationale:** Exit codes in this CLI are a machine contract that agents branch on (`exit 2` means the input was bad). Overloading one to mean "your CLI version is older than the server's palette" would make `colors` the only read command that can fail for a reason unrelated to the request. `freelo task-labels colors --output json | jq -e '.data.drift.matches'` gives a CI job the same gate, with the failure semantics chosen by the caller instead of by us. Keeping exit codes untouched also keeps the slice out of Red.
