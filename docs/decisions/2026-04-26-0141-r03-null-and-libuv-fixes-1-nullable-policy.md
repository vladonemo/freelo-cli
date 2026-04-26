# Decision 1 — Repo-wide nullable-equals-optional policy

**Run:** 2026-04-26-0141-r03-null-and-libuv-fixes
**Phase:** Spec
**Agent:** orchestrator (architect)

**Question:** Should the relaxation be per-schema-file or repo-wide policy?
**Decision:** Repo-wide policy. Every `.optional()` field on an inbound
API response schema is also `.nullable()`.
**Alternatives considered:**
- Per-schema, only fields the user reported. Cheaper now, more bug reports
  later for fields we already know are wrong.
- Distinguish absent-vs-null on a field-by-field basis where the OpenAPI
  spec is authoritative. Freelo's OpenAPI is documented loosely — it does
  not specify the absent-vs-null distinction either.
**Rationale:** For a read CLI, "tolerant input parser" wins over "strict
schema catches Freelo bugs". The cost of a missed Freelo bug is a missing
field in the envelope; the cost of being too strict is a crash like the one
in the report. Documented as a one-liner in `.claude/docs/conventions.md`
so future reviewers don't reverse it.
