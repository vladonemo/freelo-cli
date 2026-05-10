# Triage — R43

**Tier:** Yellow

## Rationale

Triggers (Yellow — any of):

- **New user-visible commands**: a new `enum` sub-parent with four leaves (`list`,
  `add`, `rename`, `delete`).
- **New non-breaking envelope schemas**: `freelo.custom-fields.enum-list/v1`,
  `…/enum-add/v1`, `…/enum-rename/v1`, `…/enum-delete/v1`.
- **Changeset will be `minor`** (additive user-visible surface).
- One destructive op (`enum delete` plus `--force` for force-delete). Pattern is
  well-trodden (R23 / R41 `delete` / R42 `value clear`).

Not Red:

- No `src/config/`, auth, HTTP client defaults, or release-tooling changes.
- No new runtime dependencies.
- No breaking changes to existing schemas, exit codes, or flag names.

## Route flags

- `requiresFreeloApi: true` — invoke `freelo-api-specialist` in parallel with `architect` for the spec.
- `needsSecurityReview: false`.
- `preApprovedDeps: []`.

## Open questions answered up-front from OpenAPI

- **Verb for `change` (rename)**: the roadmap says `PATCH`, but
  `docs/api/freelo-api.yaml:4416-4417` shows `post`. OpenAPI is canonical
  (same call as R41 spec 0055 decision 01). No pause.
- **`delete` vs `force-delete`**: both endpoints exist. `delete` is "safe"
  (refused 4xx if option in use, yaml :4479); `force-delete` cascades — clears
  referencing task values (yaml :4503). `--force` flag selects force-delete.
  No pause.
- **`add`/`rename` body**: `{ value }` (yaml :4391-4398, :4444-4448).
- **`list` pagination**: none — flat `{ custom_field_enum: [] }` (yaml :4356-4359).
- **`add` accepts caller-supplied uuid** (yaml :4394-4396). Out-of-scope for
  the CLI surface in this slice — server generates uuid by default.
