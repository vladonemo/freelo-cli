# Triage — 2026-08-29-1750-m05-task-label-colors

**Tier:** Yellow
**Commit type:** feat

## Summary

Add a read-only `freelo task-labels colors` leaf that calls
`GET /task-label-colors` and renders the palette Freelo itself accepts for
task labels. The existing hardcoded nine-name `PALETTE` in
`src/lib/label-color.ts` (R24.5) stays the authoritative, offline validator
for `--palette`; the new command is the drift check against it, not a runtime
dependency of it. Also a docs-only bookkeeping fix: mark M02 shipped in the
roadmap.

## Signals

- [x] Touches src/commands/ (new subcommand `task-labels colors`)
- [ ] Touches src/config/
- [ ] Touches src/api/client.ts or HTTP defaults
- [ ] Touches auth flows
- [ ] Adds a dependency
- [ ] Removes a dependency
- [x] Changes an envelope schema — **new** schema `freelo.task_labels.colors/v1`
- [ ] Changes exit codes
- [ ] Removes/renames an existing flag
- [x] Requires the Freelo API (`GET /task-label-colors`)
- [ ] Docs-only

## Route flags

- requiresFreeloApi: true
- needsSecurityReview: false
- preApprovedDeps: []
- allowNewDeps: false

## Rationale

**Yellow, not the Green the roadmap guessed.** Three separate Yellow triggers
from `autonomous-sdlc.md` §Risk tiers fire independently:

1. **New user-visible command** (`task-labels colors`) — additive.
2. **New envelope schema** `freelo.task_labels.colors/v1`.
3. **Changeset will be `minor`** (new user-facing surface, pre-1.0 SemVer).

Highest tier wins, and the "read-only and additive" property that makes this
feel Green is not a Green trigger — Green's example list is "doc edits,
internal refactor, new read-only subcommand, test additions", but its *first*
gate is the conjunction of the six bullets under Green, and "no new envelope
schema" is not among things a new read-only subcommand can satisfy here
because it introduces one. This is the identical correction the roadmap
already recorded for M04 at line 123: read-only-ness keeps a slice out of
**Red**; it does not pull it down to **Green**. M05 carried the same "Green
candidate" guess and gets the same answer.

The load-bearing consequence: **Green would auto-merge.** Yellow stops at an
open PR and the human takes the merge decision. Given this slice touches the
semantics of an existing validated flag surface (`--palette`) even in the
"don't touch it" design, a human merge gate is the correct posture.

**Not Red.** No `src/config/`, no auth, no `src/api/client.ts`, no TLS/retry
defaults. No breaking change: the chosen design leaves `--palette`, `--hex`,
`PALETTE`, `resolveColorFlags`, and `paletteHelpBlock` byte-for-byte behaviour
intact. The requirement's one genuinely open question (replace vs. alongside)
is a **decide-and-log** UX choice per §Autonomous decisions ("Small UX choices
with a clear precedent in the codebase"), *not* an ambiguous scope — the
success criterion is unambiguous and the OpenAPI contract settles it. Had the
design landed on "replace", it would have been a breaking behaviour change to
an existing command and therefore Red + pause; see decision 2.

## Open concerns for the architect

1. **Verify the response shape against the OpenAPI contract, not the roadmap.**
   The roadmap hedges "name + hex, if the response provides names". Check
   `docs/api/freelo-api.yaml` for `TaskLabelColor` before designing the
   envelope.
2. **`display_name` input-acceptance.** If the contract says the server's
   colour names are display-only and not accepted as input, that is decisive
   for the replace-vs-alongside question and must be quoted in the spec.
3. **Hex case.** The local `PALETTE` stores uppercase (`#15ACC0`); the
   contract's example is lowercase (`#15acc0`). Any comparison must be
   case-insensitive or it will report false drift on day one.
4. **Drift story.** "Stops silently drifting" is the stated outcome. A bare
   list only makes drift visible to a human eyeballing two tables. Decide
   whether the envelope should carry the comparison.
5. **Auth/offline.** `GET /task-label-colors` is authenticated like every
   Freelo endpoint. Weigh what a live fetch would do to `--palette` when the
   caller is offline or unauthenticated.

## Recommended branch name

`feat/task-label-colors`
