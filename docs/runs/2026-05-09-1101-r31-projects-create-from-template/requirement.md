# R31 — projects create-from-template

Wave 5, third slice. POST /project/create-from-template/{template_id}.

## CLI surface (proposed, mapped to documented body)

```
freelo projects create-from-template <template_id> --name <str>
  [--owner-id <int>]
  [--currency <CZK|EUR|USD>]
  [--date-start YYYY-MM-DD]    # → preset_date_from
  [--layout rows|kanban]
  [--worker <id>]...           # → users_ids (repeatable)
  [--dry-run]
```

## OpenAPI body (verified)

`/project/create-from-template/{template_id}` POST, properties:
- name: string
- project_owner_id: integer
- currency_iso: enum [CZK, EUR, USD]
- preset_date_from: string (date)
- general_settings.layout: enum [rows, kanban] (default rows)
- users_ids: array of integer

All optional in OpenAPI. We require `--name` at the CLI for predictability (else server defaults to template name).

## Constraints

- allowNetwork: false (MSW only)
- autoShip: false
- Yellow tier expected
- Reuse R29 patterns; no new deps
- Currency lowercase normalization (R29 pattern)
- `--dry-run` mandatory
- No batch/stdin (rare op, parity with R29)

## Run config

- run-id: 2026-05-09-1101-r31-projects-create-from-template
- branch base: main @ 82ae974
- budget: 30 min wall, 40 agent calls, 8 retries, 25 files
