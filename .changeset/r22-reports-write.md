---
'freelo-cli': minor
---

R22 — `freelo reports log` / `reports edit` / `reports delete`. Closes the write loop on the **work-reports** resource group (R21 shipped read).

```
freelo reports log    --task <id> --minutes <n> [--date YYYY-MM-DD] [--note <str>] [--dry-run] [--stdin]
freelo reports edit   <id>        [--minutes <n>] [--note <str>] [--date YYYY-MM-DD]  [--dry-run] [--stdin]
freelo reports delete <id>...     [--ids "1,2,3"] [--stdin] [--yes] [--dry-run]
```

**New envelope schemas (additive):**

- `freelo.reports.log/v1` — `data: { report, applied_input, line_index? }`.
- `freelo.reports.edit/v1` — `data: { report, applied_changes, line_index? }`.
- `freelo.reports.delete/v1` — `data: { report_id, previous_state, current_state, already_in_target_state, would?, line_index? }`. Mirrors `freelo.tasks.delete/v1` byte-for-byte modulo the field rename.

**Wire bindings (OpenAPI `docs/api/freelo-api.yaml`):**

- `reports log` → `POST /task/{task_id}/work-reports` (yaml :3045-3093).
- `reports edit` → **`POST /work-reports/{id}`** (yaml :3095-3143). Note: verb is **POST**, not PATCH — the roadmap text was wrong; same trap as R18 (comments-edit) and R20 (time-edit). The roadmap line will be reconciled in a separate follow-up doc PR after this slice merges. Spec 0034 decision 01.
- `reports delete` → `DELETE /work-reports/{id}` (yaml :3144-3171).

**Destructive command — confirmation policy:** `reports delete` is the second destructive command in the CLI (after `tasks delete`). It reuses `confirmDestructive` byte-for-byte: TTY prompt by default, `--yes` to bypass, non-TTY without `--yes` fails closed with `CONFIRMATION_REQUIRED` exit 2.

**Four-arm idempotency on delete (spec 0034 decision 02):**

1. HTTP 404 → `already_in_target_state: true`, exit 0.
2. HTTP 400 with body matching `/not found|does not exist/i` → idempotent skip, exit 0.
3. HTTP 400 containing `UserCannotDeleteWorkReport` → hard `FREELO_API_ERROR` (ACL stays observable), exit 4.
4. Other non-2xx → re-throw `FreeloApiError`.

Each arm has dedicated test coverage (Calibration §4) plus a direct unit test of the `isIdempotentDeleteSkip` helper.

**Out of scope for this slice (deferred to follow-ups):**

- `--cost` flag on log / edit. Per roadmap, money helper (`src/lib/money.ts` for cents-as-string encoding) deferred until `--cost` ships. Spec 0034 decision 03.
- `--task` re-parent flag on edit (out of scope per roadmap CLI block).
- `--worker` flag on log (caller's identity is used; delegated logging is a future slice).

**Agent-safe contract reused everywhere:**

- `--dry-run` on log / edit / delete (`would: { method, path, body }` in envelope).
- Batch input: `reports log --stdin` and `reports edit --stdin` accept rich NDJSON rows (`{task, minutes, date?, note?}` and `{id, minutes?, note?, date?}` respectively); `reports delete` supports positional / `--ids` / `--stdin` byte-compat with `tasks delete`.
- Continue-on-error in batches: bad rows emit `freelo.error/v1` envelopes with `context.line_index`; run-level exit is `max(per-row codes)`.

No new dependencies.
