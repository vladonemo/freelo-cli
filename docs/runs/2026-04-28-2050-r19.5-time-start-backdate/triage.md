# Triage — R19.5

**Run:** 2026-04-28-2050-r19.5-time-start-backdate
**Tier:** Yellow
**Decided by:** orchestrator (parent-supplied; pre-scoped roadmap slice)

## Rationale

- Additive flag (`--at <ISO>`) on an existing user-visible command (`time start`).
- No envelope schema change (output `freelo.time.start/v1` unchanged).
- No auth, HTTP defaults, or transport changes.
- No destructive surface added; backdate is server-side write but the command itself was already a write.
- Server endpoint and field (`date_reported`) are already documented in `docs/api/freelo-api.yaml:2744`.

## Route flags

- `needsSecurityReview`: **false** — no auth, no secrets, no network plumbing change.
- `requiresFreeloApi`: **true** — must verify `date_reported` semantics against `docs/api/freelo-api.yaml:2744` during /spec.
- `preApprovedDeps`: `[]` — explicit hard constraint: no new deps.

## Gate behavior

- Auto-merge: **OFF** (Yellow).
- Final action: open PR, leave for human review.

## Risks called out

- `--introspect` golden snapshot must be regenerated.
- Help-text wording must match other date-flag conventions in this repo (`--due` on `tasks create` is the precedent).
- Wire-diff cleanliness: omit `date_reported` entirely when `--at` not passed.
