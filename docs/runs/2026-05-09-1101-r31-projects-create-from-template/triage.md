# Triage — R31 projects create-from-template

**Run:** 2026-05-09-1101-r31-projects-create-from-template
**Tier:** Yellow
**Type:** feat

## Rationale

Additive write command. `POST /project/create-from-template/{template_id}` is documented in `docs/api/freelo-api.yaml` lines 759-830. New CLI subcommand `projects create-from-template`, new envelope schema `freelo.projects.create-from-template/v1`. No auth/HTTP-default changes; no new deps.

Yellow (not Green) because:
- new public envelope schema (public contract)
- write op (POST) — destructive=false but creates server-side state
- introduces 6 new flags from the OpenAPI body

Not Red:
- API spec unambiguous — every field has a documented type and the body example is explicit (Decision: which flags map → 1:1 to documented properties)
- no security/auth changes
- pattern fully established by R29 (spec 0042) — copy-paste structurally

## Route flags

- `needsSecurityReview`: false
- `requiresFreeloApi`: false (OpenAPI already inspected; body verified)
- `preApprovedDeps`: [] (no new deps)
- `allowNetwork`: false (MSW only)
- `autoShip`: false

## OpenAPI body verification (yaml :785-814)

```yaml
properties:
  name: string
  project_owner_id: integer
  currency_iso: enum [CZK, EUR, USD]
  preset_date_from: string (format: date)
  general_settings:
    layout: enum [rows, kanban] default rows
  users_ids: array of integer
```

All optional in OpenAPI. CLI requires `--name` for predictability (else server defaults to template name, surprising the agent).

## Roadmap reconciliation

Roadmap line: `--name <str> [--date-start YYYY-MM-DD] [--worker <id>]...`.

- `--date-start` → maps to documented `preset_date_from` (date format). KEEP.
- `--worker` → maps to documented `users_ids`. KEEP (renamed `--worker` → `--worker` repeatable, body field `users_ids`).
- `--name` → KEEP (required).

Additional flags justified by OpenAPI presence:
- `--owner-id` → `project_owner_id`
- `--currency` → `currency_iso` (CZK|EUR|USD enum)
- `--layout` → `general_settings.layout` (rows|kanban enum)

No flags dropped — every roadmap-suggested flag has a documented body field.

## Budget

30 min wall, 40 agent calls, 8 retries, 25 files. Previous run R30 ran 75 min — keep spec scope tight.
