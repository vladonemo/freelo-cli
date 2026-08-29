# Decision 4 — A 404 is an error on all four endpoints, for a reason the M01/M07 precedent does not supply

**Run:** 2026-08-29-1046-m03-taskchecks
**Phase:** spec
**Agent:** orchestrator (architect mandate)

**Question:** R13's `tasks delete` absorbs a 404 as idempotent already-deleted success. M01 (`comments delete`) and M07 (`files delete`) both declined to, on the grounds that their 404 is ACL-ambiguous. Which way do the four taskcheck endpoints go — and is the M01/M07 reasoning actually the applicable one here?

**Decision:** No 404 absorption on any of `edit`, `delete`, `finish`, `reopen`. Every 404 surfaces as `FreeloApiError` / `NOT_FOUND` / exit 4 / `retryable: false`. Derived per endpoint, not inherited.

**Alternatives considered:**

- **Follow R13** — absorb on `delete`, and by extension treat `finish`/`reopen` 404s as "already in that state". Rejected: see rationale.
- **Copy M01/M07's stated rationale verbatim** (404 is ACL-ambiguous per the yaml). Rejected as the *primary* justification, because it is not actually supported here: `files delete` has an explicit `'404'` response object whose description says "or the caller has no access to it" (yaml :4504). The four taskcheck operations declare **no `404` response object at all**, so that ACL wording cannot be assumed to carry over. Reaching the right answer through an argument the contract does not support would be pattern-matching, which is exactly what the requirement asked to avoid.
- **Split the policy by verb** — e.g. strict on `delete`, lenient on `finish`/`reopen` since those are reversible. Rejected: the governing reason (below) is verb-independent.

**Rationale:** The single 404 meaning these endpoints *do* document (yaml :2124, :2161, :2179, :2212) is **"you passed an id from the other id space"** — the resource exists, is untouched, and is reachable through a different command. Absorbing that as success would report exit 0 while the user's checklist item sits unmodified, and the user would never learn to retry against `freelo tasks …`. That is strictly worse than the M01/M07 case, where the absorbed outcome was at least plausibly "already gone". Secondarily, with no `404` response object declared, any success semantics built on that status would be inventing contract. The user-facing message stays a plain `Taskcheck <id> not found.` — the CLI cannot distinguish wrong-id-space from nonexistent from invisible, so it asserts none of them; all three possibilities live in `hint_next`, mirroring M07's message/hint discipline. Pinned by one regression test per verb.
