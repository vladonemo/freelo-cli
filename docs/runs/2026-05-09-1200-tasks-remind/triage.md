# Triage — R35 `freelo tasks remind`

**Run:** 2026-05-09-1200-tasks-remind
**Tier:** Yellow
**Rationale:** Adds a new top-level user-visible subcommand (`tasks remind set`/`tasks remind clear`). Both are additive — no existing flag/command/envelope changes. `clear` is destructive (it removes a server-side resource); reuses the established `confirmDestructive` + `--yes` + idempotency-on-404 pattern from R13. Endpoints are documented in `docs/api/freelo-api.yaml:2067-2135` (POST + DELETE on `/task/{task_id}/reminder`); no API ambiguity. No new runtime dependency. No auth, HTTP-client default, or release-tooling changes.

**Route flags:**
- `requiresFreeloApi`: yes — confirm against yaml. **Confirmed**: lines 2067-2135 document both verbs. POST request requires `{ remind_at: ISO 8601 string }`; response is `{ remind_at, task: { id, name } }`. DELETE has no body; response is `SuccessResponse`. DELETE is **already idempotent on the server** ("calling with no reminder present returns 200" — yaml :2125).
- `needsSecurityReview`: no (no auth surface, no config touch, no new HTTP defaults).
- `preApprovedDeps`: `[]` — no new deps required.
- `breakingChange`: no (additive only).
- `changesetType`: `minor` (new user-visible subcommands).

**Pre-approved decisions inherited from precedent:**
- Reuse `parseIsoTimestampFlag` from `src/lib/iso-timestamp.ts` (R19.5 / spec 0031) for `--at <ISO>` parsing — same canonicalization, same clock-skew clamp.
- `clear` follows the `tasks delete` (R13, spec 0024) destructive pattern: `confirmDestructive` once for the run, non-TTY without `--yes` → `ConfirmationError` (exit 2), TTY without `--yes` → interactive prompt.
- `set` is an upsert (yaml :2081) → not destructive; no confirmation; `--dry-run` echoes wire body.
- DELETE 404 → already-no-reminder → `already_in_target_state: true` (mirrors R13 §3.4); but server says 200 already, so 404 path is defensive only.
- Single-id v1 (no batch) — keeping the slice small; `set` body is non-trivial (`--at` per row would force NDJSON). Batch can land as R35.5 if needed, mirroring R12.5 / R12 split.
