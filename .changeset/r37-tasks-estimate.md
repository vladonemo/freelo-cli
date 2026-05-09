---
'freelo-cli': minor
---

Add `freelo tasks estimate set` / `tasks estimate clear` (R37).

**Surface (additive — no breaking change):**

```
freelo tasks estimate set   <id> --minutes <n> [--user <id>] [--dry-run]
freelo tasks estimate clear <id>                [--user <id>] [--yes] [--dry-run]
```

Each leaf wraps one of four Freelo endpoints, with the `--user <id>` flag
acting as a path toggle between team-wide and per-user estimates:

- `set` (without `--user`) →
  `POST /task/{task_id}/total-time-estimate` with `{ minutes: <n> }`.
- `set --user <id>` →
  `POST /task/{task_id}/users-time-estimates/{user_id}` with `{ minutes: <n> }`.
- `clear` (without `--user`) →
  `DELETE /task/{task_id}/total-time-estimate`.
- `clear --user <id>` →
  `DELETE /task/{task_id}/users-time-estimates/{user_id}`.

`set` is non-destructive — the server upserts on every call (yaml :2267,
:2324). `--minutes` is required; positive integer (>= 1).

`clear` is destructive; reuses the shared `confirmDestructive` gate from
R13 / R35 / R36 — `--yes` bypasses, TTY without `--yes` prompts, non-TTY
without `--yes` fails closed with `CONFIRMATION_REQUIRED` (exit 2). The
prompt copy is scope-aware: `"Clear total time estimate on task #<id>?"`
or `"Clear time estimate for user #<user> on task #<id>?"`.

Per-user estimates are independent of the total: setting a per-user value
does NOT update the total (yaml :2325). The CLI does not aggregate.

**Output schemas (new):**

- `freelo.tasks.estimate.set/v1` —
  `{ task_id, user_id (null|int), minutes, scope ('total'|'user'), would? }`.
- `freelo.tasks.estimate.clear/v1` —
  `{ task_id, user_id (null|int), scope, already_in_target_state, would? }`.

The `scope` field is a discriminator derived from `--user` presence so
agents can branch without parsing the wire path.

**Idempotency note for `clear`:** the server returns 200 even when no
estimate existed (yaml :2299, :2362), so the wire cannot distinguish "had
an estimate" from "had no estimate". Live 200 always emits
`already_in_target_state: false`; a defensive 404 (forward-compat path)
is re-classified as `already_in_target_state: true`. Mirrors R13 / R35 /
R36 precedent.

Single-id v1; batch (`--ids` / `--stdin`) deferred to a future R37.5 if
demand emerges. Spec: `docs/specs/0051-r37-tasks-estimate.md`.
