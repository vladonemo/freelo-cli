# Decision 2 — Tier Yellow, against the roadmap's "Green candidate" read

**Run:** 2026-08-25-0909-tasks-list-order-by-due-date
**Phase:** triage
**Agent:** orchestrator (acting as triage; sub-agent delegation unavailable this session)

**Question:** Does widening an existing flag's accepted value set count as "a new user-visible flag"
(Yellow) or as a mechanical additive change (Green)? `docs/roadmap-migration-2026-08.md` §M08 calls it
a "Green candidate"; the requirement asked triage to confirm rather than inherit that.

**Decision:** Yellow. Full pipeline runs, PR opens, **auto-merge is not enabled** — a human merges.

**Alternatives considered:**

- **Green**, on the letter of the rule: all six Green preconditions in `autonomous-sdlc.md` hold
  (no auth/config/HTTP-client/release-tooling changes, no new deps, no breaking change to envelope
  schema, exit codes, or flag names). No new *flag* is added.
- **Yellow**, on two triggers (chosen).
- Red — no trigger fires; not seriously considered.

**Rationale:** Two Yellow triggers fire. (1) "New user-visible command or flag (additive)" — not
literally a new flag, but the public surface grows: `--order-by`'s help string changes and
`freelo --introspect`, a declared public contract in `CLAUDE.md`, emits it; a user can now do
something that previously exited 2. (2) "Changeset is `minor`" — this is new backwards-compatible
functionality, and repo precedent is unambiguous that "users can now do X" ships Minor, including the
closest analogue in size (`0.13.0`, "Add `--palette <name>` flag on three label-write commands").
`autonomous-sdlc.md` says highest tier wins on conflicting signals, and triage's own hard rule says
don't downgrade because something "should be simple."

Considered and rejected: reframing as `fix` + `patch` ("the CLI's whitelist drifted from the contract;
resync it"), which would have made it Green. That is wrong on the facts — the four-value enum was
correct until PR #112 landed the refreshed spec. The capability is newly available upstream, not
previously broken downstream.

**Note on doc inconsistency, for a future calibration entry:** `autonomous-sdlc.md` lists "new
read-only subcommand" as a *Green* example while also listing "New user-visible command or flag
(additive)" and "Changeset is `minor`" as *Yellow* triggers. A new read-only subcommand is always
both. These cannot both be right; the Yellow triggers were treated as authoritative here since they
are stated as rules and the Green line is stated as an example.
