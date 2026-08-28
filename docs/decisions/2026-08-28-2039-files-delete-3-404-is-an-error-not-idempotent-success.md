# Decision 3 — A 404 on `files delete` is an error, not idempotent success

**Run:** 2026-08-28-2039-files-delete
**Phase:** spec
**Agent:** orchestrator (executing the `architect` mandate)

**Question:** Should `files delete` absorb a 404 into a success with `already_in_target_state: true` —
the `src/lib/idempotency.ts` pattern used by every delete in this CLI except M01's — or surface it as a
real error?

**Decision:** Surface it as a real error: exit 4, `code: 'NOT_FOUND'`, no idempotency absorption, no
pre-check `GET`. `already_in_target_state` stays in the envelope for cross-command uniformity but is
constant `false` in v1.

**Alternatives considered:**

- **Absorb the 404 as `already_in_target_state: true`** (the majority pattern — `tasks delete`,
  `tasklists delete`, `projects delete`). Rejected: see rationale.
- **Pre-check with `GET /file/{uuid}` and branch on the result.** Rejected on two grounds — the GET sits
  behind the same ACL so it cannot disambiguate either, and it doubles the request count for no
  information.
- **Absorb only when a prior DELETE in the same invocation already succeeded for that UUID** (i.e.
  de-duplicate). Rejected as a silent input rewrite that solves a narrow case while leaving the general
  one wrong.

**Rationale:** The requirement explicitly demanded this be re-derived from the endpoint's own
documentation rather than copied from M01's precedent, so it was. `docs/api/freelo-api.yaml` :4504 reads:
"Returns 404 if no file or document matches the UUID, **or the caller has no access to it**." The
idempotency pattern is only sound when a 404 unambiguously means "already in the target state"; here it
does not. Case two — resource exists, caller can't see it — would make the CLI print "deleted" and exit 0
for a document still sitting untouched in another project, and a UUID is easily copied from a colleague,
a wiki or a CI log. Reporting "removed" for something not removed is the one failure mode a delete
command must never have.

The conclusion coincides with M01's but the reasoning is independent and rests on this endpoint's own
sentence. Had :4504 stopped at "if no file or document matches the UUID", the ordinary idempotency
treatment would have been specified instead. Pinned by regression tests asserting exit 4 plus the
*absence* of a success envelope, so a later "let's make the deletes consistent" refactor fails loudly.
