# Decision 3 — Sweep depth for Bug #1 (`UserBasic.fullname` nullability)

**Run:** 2026-04-26-1848-r05-5-hardening
**Phase:** Spec
**Agent:** orchestrator (architect role)

**Question:** Bug #1 reproducer cited `UserBasic.fullname`. Do we sweep
deeper, and how deep?

**Decision:** Relax three additional fields beyond the cited one:
- `UserBasicSchema.fullname` — the cited field.
- `WorkerWithHourRateSchema.fullname` — the same property on the
  worker-with-hour-rate variant; same risk.
- `HourRateSchema.{amount, currency, is_fixed}` — partial-rate records
  reported in adjacent prior runs; same defensive policy.

**Alternatives considered:**
- Cited field only — too narrow. `WorkerWithHourRate.fullname` shares
  the same Freelo data source; if `UserBasic.fullname` can be missing,
  `WorkerWithHourRate.fullname` can too. Future repro guaranteed.
- Full audit of every required field across `src/api/schemas/*.ts`
  against `docs/api/freelo-api.yaml` — a separate work item; out of
  scope for a patch release.

**Rationale:** Spec 0010 §1.3 already documented "every optional field
on an inbound API response schema is also nullable." This run extends
the same posture one half-step: also relax fields where the wire
shape *could* admit missing/null even though we wrote them as required.
We do not loosen primary keys (`id`) or true enum/state discriminators
(`StateSchema`).
