---
'freelo-cli': minor
---

R23 — `freelo labels list` / `labels rename` / `labels delete` / `labels attach` / `labels detach`. Adds the project-labels resource group (read + full write surface) in one slice.

```
freelo labels list                                                              [--output ...]
freelo labels rename <id>           [--name <str>] [--hex <color>] [--is-private | --is-public] [--dry-run]
freelo labels delete <id>...        [--ids "1,2,3"] [--stdin] [--yes] [--dry-run]
freelo labels attach --project <id> --name <str>... [--hex <color>] [--private | --public] [--dry-run]
freelo labels detach --project <id> --label <id>... [--ids "1,2,3"] [--stdin]    [--dry-run]
```

**Five new envelope schemas (additive):**

- `freelo.labels.list/v1` — `data: { labels: ProjectLabel[] }`.
- `freelo.labels.rename/v1` — `data: { label_id, applied_changes }` (intent, not server-confirmed state — same caveat as `time edit` / `reports edit`).
- `freelo.labels.delete/v1` — `data: { label_id, previous_state, current_state: "deleted", already_in_target_state, would?, line_index? }`.
- `freelo.labels.attach/v1` — `data: { project_id, name, is_private, color?, would? }`. **Notably no `already_in_target_state`** — see decision 08 below.
- `freelo.labels.detach/v1` — `data: { project_id, label_id, previous_state, current_state: "detached", already_in_target_state, would?, line_index? }`.

**Wire bindings (OpenAPI `docs/api/freelo-api.yaml`):**

- `labels list` → `GET /project-labels/find-available` (yaml :833).
- `labels rename` → **`POST /project-labels/{labelId}`** (yaml :862). Verb is **POST**, not PATCH — the roadmap text was wrong; same trap as R18 / R20 / R22. (Spec 0035 decision 01.)
- `labels delete` → `DELETE /project-labels/{labelId}` (yaml :905).
- `labels attach` → `POST /project-labels/add-to-project/{projectId}` (yaml :934, data-mode).
- `labels detach` → **`POST /project-labels/remove-from-project/{projectId}`** (yaml :991). Verb is **POST**, not DELETE — roadmap was wrong. (Spec 0035 decision 02.)

**`labels delete` is GLOBAL hard-delete** (yaml :917 — "hard delete of the global label, not a detach from one project"). The TTY confirmation copy says **"Delete N labels GLOBALLY (across all projects)?"** so a human user has a clear scope signal. (Decision 10.) Confirmation policy mirrors `tasks delete` / `reports delete` byte-for-byte: TTY prompt; non-TTY requires `-y` / `--yes` or fails closed with `CONFIRMATION_REQUIRED` exit 2.

**Idempotency:**

- `labels delete` — two-arm matrix (decision 09): 404 → `already_in_target_state: true`, exit 0; otherwise re-throw. (No documented 400 fallback for already-deleted on this endpoint.)
- `labels detach` — same two-arm matrix: 404 → `already_in_target_state: true`, exit 0.
- `labels attach` — server swallows `UniqueConstraintViolationException` server-side, so the CLI cannot distinguish first-attach from re-attach. The envelope **omits `already_in_target_state` entirely** rather than guess. Agents needing ground truth can call `labels list` before/after and diff. (Decision 08.)

Each typed-error path has dedicated test coverage (Calibration §1-2) plus direct unit tests of both `isIdempotentDeleteSkip` and `isIdempotentDetachSkip` matrices (Calibration §4).

**Roadmap-vs-API reconciliations (deferred surface):**

- `labels list --project <id>` — **deferred**. The documented endpoint accepts no query parameters and `ProjectLabel` carries no `attached_projects` field. Tracked as future slice R23.5. (Spec 0035 decision 03.) Same precedent as R20.5 (`--started-at`) and R12.5 (`--pairs`).
- `labels attach` id-mode body — **deferred**. v1 surfaces only data-mode (`--name <str>`, fetch-or-create). (Decision 07.)
- `labels detach` data-mode (by name) — **deferred**. v1 surfaces only id-mode. (Spec §8 non-goals.)
- No batch input on `labels rename` in v1 (would require rich NDJSON shape).

**Flag-name decision: `--hex` instead of `--color` for `rename` / `attach` (decision 11).** The spec called for `--color <hex>`, but the CLI's root program already defines a global `--color <mode>` flag (auto/never/always) for output colorization. Commander shadows: when both root and subcommand register the same flag name, the root wins regardless of registration order, so the subcommand's `--color <hex>` would silently absorb into the root flag. Renaming the subcommand flag to `--hex <color>` removes the ambiguity without breaking any other command. The wire-body field is still `color` and the envelope field is still `color` / `applied_changes.color` — the rename is purely lexical at the CLI layer.

**Agent-safe contract reused everywhere:**

- `--dry-run` on every write (`would: { method, path, body }` in envelope).
- Batch input: `delete` and `detach` support positional / `--ids` / `--stdin`; `attach` fans out one POST per `--name`.
- Continue-on-error in batches: bad rows emit `freelo.error/v1` envelopes with `context.line_index` (or `input_index`); run-level exit is `max(per-row codes)`.
- Default `is_private: true` for `attach` (matches Freelo web UI default — labels are per-user-private unless explicitly shared). Decision 06.

No new dependencies.
