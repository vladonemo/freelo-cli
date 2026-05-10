# Triage — 2026-05-10-r40-custom-fields-types-list

**Tier:** Yellow

## Rationale

The slice is two new read-only subcommands under a brand-new top-level
`custom-fields` parent.

Yellow triggers met:

- **New user-visible commands** (`freelo custom-fields types`, `freelo custom-fields list`) — additive.
- **New envelope schemas** (`freelo.custom-fields.types/v1`, `freelo.custom-fields.list/v1`) — additive only.
- **Changeset is `minor`** (new commands surface).

Green-tier exclusions checked and clear:

- No changes to `src/config/`, auth flows, `src/api/client.ts`, or release tooling.
- No new runtime dependencies.
- No breaking change to envelope schema, exit codes, or flag names.
- Read-only — no destructive op, no `--yes`, no confirmation flow.
- No security-auditor trigger (no auth/config/secrets paths touched).

Per `.claude/docs/autonomous-sdlc.md` Yellow flow: full pipeline → open PR →
**stop before merge** for human review. Do not enable auto-merge.

## Route flags

- `needsSecurityReview`: **false** (no auth/config/secrets touched).
- `requiresFreeloApi`: **false** — both endpoints are documented in
  `docs/api/freelo-api.yaml:4012` and `:4529`. The `CustomField` schema
  (`:6054`) is also fully documented.
- `preApprovedDeps`: `[]` — no new deps expected.

## Endpoints (from OpenAPI)

| Endpoint | Method | Yaml line | Response shape |
| --- | --- | --- | --- |
| `/custom-field/get-types` | GET | 4012 | `{ custom_field_types: [{ uuid, name }] }` |
| `/custom-field/find-by-project/{project_id}` | GET | 4529 | `{ custom_fields: CustomField[], is_commander: boolean }` |

`CustomField` shape (yaml :6054): `{ uuid, custom_fields_types_uuid, project_id, author_id, name, date_add, priority }`.

## OpenAPI quirks

- Description at yaml :4543 says "Includes enum fields with their options
  embedded" but the documented `CustomField` schema (`:6054`) has no enum
  options field. We will apply `.nullable().optional()` + `.passthrough()`
  per the project-wide schema convention so future Freelo additions don't
  fail validation. No client-side use of an embedded enum-options array
  in this slice.
- `is_commander: boolean` is a useful agent signal (gates the admin-level
  mutation endpoints in R41+). Surface it in the envelope `data`.
- Soft-deleted custom fields excluded server-side (yaml :4542) — no
  client-side scope flag needed.

## Tier confirmed: Yellow

Proceed to spec phase.
