# Decision 5 — `--should-change-existing-tasks` gets the full R13 confirmation gate; the rest of `tasklists edit` stays ungated

**Run:** 2026-08-29-0921-tasklists-edit
**Phase:** 2 (spec)
**Agent:** orchestrator (inline)

**Question:** `should_change_existing_tasks: true` propagates a follower change to every existing task in the tasklist — a wide side effect on a command that deletes nothing. Does it deserve the `--yes` / TTY-prompt gating this CLI reserves for destructive ops (R13, `src/lib/confirm.ts`)?

**Decision:** **Yes, but narrowly scoped.** `confirmDestructive()` is invoked **only when `--should-change-existing-tasks` is passed**. Every other invocation of `tasklists edit` — rename, budget, worker, priority, even a follower change *without* propagation — is completely ungated and needs no `--yes`.

Concretely:
- `freelo tasklists edit 9001 --name Foo` → no gate, works unattended.
- `freelo tasklists edit 9001 --tracking-users 12` → no gate (affects the tasklist only).
- `freelo tasklists edit 9001 --tracking-users 12 --should-change-existing-tasks` → gated.
- Non-TTY without `--yes` → `ConfirmationError`, exit 2 (fail closed, standard R13 contract).
- `--dry-run` → proceeds without prompting (R13 contract; no effect to guard).

Two additional rulings that fell out of this:

- **`--should-change-existing-tasks` requires a follower change.** Passing it without `--tracking-users` or `--clear-tracking-users` is a `ValidationError`. The OpenAPI defines it purely as a modifier ("*Combine with* `should_change_existing_tasks: true` to also propagate the change"); alone it is a no-op the server ignores silently. Rejecting it is better than sending a request that quietly does nothing.
- **`meta.destructive` stays `false`.** See rationale below.

**Alternatives considered:**

- **(A) No gate at all** — the flag is long, explicit and self-documenting; typing it *is* the confirmation. `CLAUDE.md` scopes the confirm gate to "Destructive ops", and nothing is deleted here.
- **(B) Gate the whole `tasklists edit` command** whenever any follower flag is present.
- **(C) Gate only the worst case** — `--should-change-existing-tasks` combined with `--clear-tracking-users` (strip all followers from every task).
- **(D) Set `meta.destructive: true`** so `--introspect` advertises the command as destructive.

**Rationale:**

(A) is the strongest counter-argument and nearly won: an explicit opt-in flag really is a form of consent, and gating imposes friction on the agent-first path. It was rejected because consent to *the flag* is not the same as understanding *the blast radius*. The flag name says "should change existing tasks"; it does not say "all of them, irreversibly, with no per-task undo and no echo in the response". The response body carries only `priorityApplied` — the API returns **no record of which tasks were touched**, so there is no way to review or reverse the propagation afterward. The R13 gate exists to stop exactly this: an effect wider than the user's mental model, with no cheap recovery. Data loss is not the criterion; unrecoverable surprise is.

(B) was rejected because it would gate the common, safe case (`--tracking-users` on the tasklist alone, which touches one row) and would drag `--name`-only edits into a `--yes` requirement in any invocation that also set followers. That is friction with no matching risk, and it would make the most-used write on this resource unusable unattended.

(C) was rejected as too clever. `--clear-tracking-users --should-change-existing-tasks` is the worst case, but *replacing* the follower set across every task is also unrecoverable and also invisible in the response. Splitting the gate by which follower flag was used would produce a rule users cannot predict. Instead the **prompt copy** varies by case — the clear-all variant states "REMOVE ALL FOLLOWERS from EVERY existing task", the replace variant states "propagate this follower change to EVERY existing task" — so the severity is communicated where it matters without making the gate itself conditional on it.

(D) was rejected because `destructive` in `CommandMeta` (`src/lib/introspect.ts:22`) is a **static, whole-command** boolean that `--introspect` consumers read to decide whether an operation destroys data. Neither claim is true here: the command is not destructive, and the gate applies to only one of its eleven flags. Marking it `true` would tell every agent that `tasklists edit --name Foo` destroys data, which is false and would suppress legitimate automation. The conditional gate is expressed in the flag's help text and in the docs page instead. This is a real, if minor, expressiveness gap in `CommandMeta` — noted for a future slice, not worked around here by lying in the metadata.

**Cost accepted:** an agent that wants unattended follower propagation must pass `--yes`. That is one flag, it is the global flag it already passes for deletes, and `--dry-run` gives a free preview first.
