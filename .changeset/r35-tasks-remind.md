---
'freelo-cli': minor
---

Add `freelo tasks remind set` / `tasks remind clear` (R35).

**Surface (additive — no breaking change):**

```
freelo tasks remind set <id> --at <ISO> [--dry-run]
freelo tasks remind clear <id> [--yes] [--dry-run]
```

Each leaf wraps one Freelo endpoint:

- `set` → `POST /task/{task_id}/reminder` with `{ remind_at: <UTC ISO> }`.
  Upsert semantics on the server (a second call overwrites the prior
  `remind_at`). Required flag.
- `clear` → `DELETE /task/{task_id}/reminder`. Destructive; reuses the
  shared `confirmDestructive` gate from R13 — `--yes` bypasses, TTY without
  `--yes` prompts, non-TTY without `--yes` fails closed with
  `CONFIRMATION_REQUIRED` (exit 2).

**`--at` validation:**

- Permissive RFC 3339 / ISO 8601 acceptance (full UTC, tz-offsets, bare
  date, milliseconds). Canonicalized to second-precision UTC
  `YYYY-MM-DDTHH:MM:SSZ` before sending.
- Rejects timestamps more than 60 s in the past (clock-skew clamp) — a
  past reminder is meaningless. The 60 s tolerance accommodates NTP drift
  and integration-replay handoff lag.
- Sibling helper to R19.5's `parseIsoTimestampFlag` (which clamps the
  *future* direction for backdating); both share the
  `ISO_TIMESTAMP_FUTURE_SKEW_MS` constant.

**Output schemas (new):**

- `freelo.tasks.remind.set/v1` — `{ task_id, task_name?, remind_at, would? }`.
- `freelo.tasks.remind.clear/v1` — `{ task_id, already_in_target_state, would? }`.

**Idempotency note for `clear`:** the server returns 200 even when no
reminder existed (yaml :2125), so the wire cannot distinguish "had a
reminder" from "had no reminder". Live 200 always emits
`already_in_target_state: false`; a defensive 404 (forward-compat path) is
re-classified as `already_in_target_state: true`.

Single-id v1; batch (`--ids` / `--stdin`) deferred to a future R35.5 if
demand emerges. Spec: `docs/specs/0049-r35-tasks-remind.md`.
