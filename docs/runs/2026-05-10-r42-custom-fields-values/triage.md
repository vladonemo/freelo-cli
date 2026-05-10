# Triage — R42 custom-fields value set / clear

**Run:** 2026-05-10-r42-custom-fields-values
**Date:** 2026-05-10

## Tier: Yellow

## Rationale

- Two new user-visible commands (`custom-fields value set` and `custom-fields value clear`), purely additive — Yellow trigger "New user-visible command".
- One destructive op (`value clear`) but the destructive-op pattern is already established in the codebase (`labels delete`, `reports delete`, `tasks delete`). `--yes`/TTY-prompt + 404 idempotency is reuse, not new policy.
- No auth, config, HTTP client default, or release-tooling changes.
- No new dependencies.
- No breaking changes — both new schemas + new flags.
- Changeset will be `minor` (additive user-visible commands).

## Route flags

- `needsSecurityReview`: false — no `src/config/`, auth flow, TLS/retry/redirect changes; standard write commands.
- `requiresFreeloApi`: true — three endpoints (two POST, one DELETE) plus a read-back via `GET /task/{task_id}` for `value clear`.
- `preApprovedDeps`: [] — no new deps expected. Reuses `zod`, `commander`, `undici`, existing helpers.

## Risks called out for spec phase

- **DELETE takes value-uuid, not field-uuid.** The CLI surface is `(task, field)`. Need to read-then-delete via `GET /task/{task_id}` → find `custom_fields[].field_uuid === <field>` → `value_uuid` → DELETE that uuid. Spec must describe this look-up explicitly.
- **Two POST endpoints with different body shapes.** The scalar endpoint uses snake_case `custom_field_uuid`; the enum endpoint uses camelCase `customFieldUuid`. CLI dispatches on `--value` vs `--enum` mutex.
- **Idempotency for `value clear`:** if no value found on the task for that field → return `already_in_target_state: true` (don't even hit DELETE); if DELETE returns 404 → also idempotent skip. Two-arm matrix mirrors `labels delete`.
- **Mutex:** `--value <str>` and `--enum <uuid>` for `set` are mutually exclusive (and one is required).

## Decision: proceed
