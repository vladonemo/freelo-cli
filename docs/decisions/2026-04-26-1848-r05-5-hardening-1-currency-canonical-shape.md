# Decision 1 — Currency canonical envelope shape on `Currency.amount`

**Run:** 2026-04-26-1848-r05-5-hardening
**Phase:** Spec
**Agent:** orchestrator (architect role)

**Question:** Live Freelo API returns `Currency.amount` as both string
and number. After widening `CurrencySchema` to accept both, what is the
canonical shape inside our envelopes?

**Decision:** Normalize to **string** at the schema level via
`z.union([z.string(), z.number()]).refine(finite).transform(String)`.

**Alternatives considered:**
- (a) Preserve as-is (envelope carries whatever Freelo sent per record).
- (b) Normalize to string. **Chosen.**
- (c) Normalize to number.

**Rationale:** Backwards-compatible with every envelope already shipped
(`freelo.projects.list/v1`, `freelo.projects.show/v1`,
`freelo.tasklists.list/v1` — all carry `amount: string` today).
OpenAPI documents the type as string. JS number loses precision past
2^53 — a poor general policy for money. Existing human renderers
(`src/ui/human/projects-list.ts:79`) already string-format the amount;
no UI change needed.
