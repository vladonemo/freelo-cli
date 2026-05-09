# Decision 1 — No GET pre-check on `projects archive` / `projects activate`

**Run:** 2026-05-09-0917-r30-projects-archive-activate-delete
**Phase:** spec
**Agent:** orchestrator (architect)

**Question:** Should `projects archive` and `projects activate` issue a GET pre-check on `/project/{id}` to observe state before POSTing, mirroring the R11 `tasks finish` / `tasks reopen` flow?

**Decision:** No — POST always; trust the server's documented idempotency.

**Alternatives considered:**
- (a) Mirror R11 exactly: GET → checkIdempotency → POST or skip. Surfaces `previous_state` and `already_in_target_state: true` in the envelope.
- (b) GET only on `activate` (because of its dual-mode unarchive/undelete behavior). Keep `archive` with no pre-check.
- (c) Chosen: no GET pre-check on either; envelope omits `previous_state` and `already_in_target_state` for these two verbs.

**Rationale:**
1. The Freelo OpenAPI explicitly documents server-side idempotency for both endpoints (yaml :635 archive, :662 activate). A redundant client GET costs a round-trip per call for no behavioral difference on the wire.
2. `GET /project/{id}` on a soft-deleted project can 404 (deleted projects "disappear from all listings", yaml :562). The `activate` verb is supposed to undelete — handling the 404 specially (treating it as "deleted, proceed to POST") is brittle and adds branches.
3. Trading one round-trip for an unobservable `previous_state` field is a bad ergonomics tradeoff. Agents that genuinely need previous state can call `freelo projects show <id>` first; that's a one-extra-line cost paid only by callers who actually want it.
4. The diverging shape from `tasks finish/reopen` is intentional and surfaced in the spec (§3.3, decision 5). The `delete` command DOES carry `already_in_target_state` because the DELETE response itself observes the prior state via the 404 → idempotent re-classification — that's free, no extra round-trip.
