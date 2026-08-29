# Decision 8 — `--clear-budget` sends `budget: null`, not `budget: "0"`

**Run:** 2026-08-29-0921-tasklists-edit
**Phase:** 2 (spec)
**Agent:** orchestrator (inline)

**Question:** The OpenAPI says of `budget`: "`null` or `"0"` clears the budget". Both work. Which does the CLI emit for `--clear-budget`?

**Decision:** **`null`.**

**Alternatives considered:**

- `"0"` — arguably more explicit about the resulting numeric state, and stays within the declared `type: string`.
- Make it configurable via a flag. (Rejected without further thought: a flag to pick between two encodings of one outcome is pure surface area.)

**Rationale:** `null` makes all three clear-flags on this command uniform on the wire — `budget: null`, `time_budget_minutes: null`, `worker_id: null` — so "explicit null clears" is one rule a reader learns once, rather than one rule with an exception. It also matches the CLI-wide convention already used by R10's `priority_enum: null`. The `budget` property is declared `nullable: true`, so `null` is squarely inside the contract, not a tolerated edge.

`"0"` additionally risks a semantic collision that `null` does not: a budget explicitly *set to zero* and a budget *cleared* would become indistinguishable both on the wire and in the `applied_changes` echo. `null` keeps "no budget" and "a budget of zero" separable — which matters for consistency with `--time-budget-minutes 0` on this same command, where `0` is a real, legal value distinct from `null` (spec `minimum: 0`). Picking `"0"` for budget would have made the two money-ish fields behave differently from one another for no gain.
