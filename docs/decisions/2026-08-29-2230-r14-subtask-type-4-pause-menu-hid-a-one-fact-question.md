# Decision 4 — The pause offered five options when one fact settled three of them

**Run:** 2026-08-29-2230-r14-subtask-type
**Phase:** Retrospective (written 2026-08-31, after PR #124 merged)
**Agent:** freelocli session

**Question:** The Spec-phase pause put five options (A–E) to the human. Was that the right shape of question?

**Decision:** **No.** It should have led with the fact, not the menu.

## What happened

The pause asked whether deriving `storage_form` from `Subtask.type` was worth its blast
radius, and offered: A land the declaration only, B full change, C full change plus `/v2`,
D capture a fixture first, E abort. That framed a **contract** question as a **preference**
question.

The human picked D. One capture showed `POST /task/{id}/subtasks` returns no `type` at all.
**B and C were not implementable** — not riskier, impossible. A was the only surviving option,
and E was never live. The five-way judgement call was a one-fact question wearing five options.

## Why it matters beyond this run

The menu asked the maintainer to exercise judgement he was **not in a position to exercise**,
because the information that would have made three options disappear had not been gathered.
The cost was two round-trips and a decision that could not actually be made as posed.

Note the pause was otherwise correct: the run was `allowNetwork: false`, so it could not have
obtained the fact itself. **Pausing was right; presenting a preference menu was not.** The
correct pause would have been a one-line request for the capability to answer OQ-2, with the
options named as *contingent* on it.

## How to apply

When drafting pause options, for each one write down the fact that would make it impossible.
Then:

- If that fact is cheap and reachable, **get it before pausing.**
- If it needs something only the human can grant (an account, a credential, a network-enabled
  run), **ask for that** — do not offer a menu whose branches that fact would prune.
- Only present a genuine menu for what remains a real judgement call after the facts are in.

A pause that asks for a preference should not be hiding an unanswered question of fact.

## Counter-consideration

This is not an argument for gathering facts indefinitely before pausing. The test is narrow:
*would this specific fact remove options from the menu I am about to present?* If no, the menu
is honest. If yes, the menu is premature.
