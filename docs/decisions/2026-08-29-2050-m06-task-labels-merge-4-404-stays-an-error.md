# Decision 4 — The 404 is handled explicitly, stays an error, and keeps a plain message

**Run:** 2026-08-29-2050-m06-task-labels-merge
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** This endpoint's `responses:` map declares only `'200'`. M03 decision 4 found that the
M01/M07 ACL-hides-existence reasoning does not transfer to endpoints that declare no 404 response
object. Does the CLI handle a 404 here at all, and if so, how?

**Decision:** Handle it explicitly, keep it an error, keep the message plain
("One or more of the labels was not found."), and put the ownership nuance in `hint_next` only.
`src/lib/idempotency.ts` is not used. Pinned by a regression test.

**Alternatives considered:**

- Treat the 404 as an idempotent already-merged success. Genuinely tempting here in a way it was
  not for `files delete`: merge really is idempotent server-side, so a repeat is a no-op. Rejected
  because the CLI cannot distinguish "already merged" from "you do not own this label" from "this
  uuid never existed" — yaml :2947 collapses them deliberately — and reporting exit 0 for a merge
  that never touched the user's data is the one failure this command must not have.
- No 404 branch at all, on a literal reading of M03 decision 4's "no declared 404 response object"
  test. Rejected: M03's actual rule was *derive the policy from this endpoint's own contract*, and
  this endpoint's own description states the 404 outright (yaml :2947). The response map is silent;
  the prose is not, and this yaml consistently puts non-obvious behaviour in prose.
- Say "not found or not owned by you" in the message. Rejected on M07 decision 3's precedent: the
  CLI cannot tell which case it hit, so the headline asserts neither.

**Rationale:** Documented behaviour gets handled; ambiguous behaviour does not get disambiguated by
guessing. No 400 or 403 rewrite exists for the same reason in reverse — those statuses are
undocumented here, so any message the CLI wrote for them would be invented.
