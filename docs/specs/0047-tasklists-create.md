# Spec 0047 — `freelo tasklists create` / `tasklists create-from-template` (R34 partial)

**Run:** 2026-05-09-1200-tasklists-create-delete
**Tier:** Yellow
**Status:** Active
**Last Wave 5 slice (partial):** delete deferred to R34.5

## Summary

Ship two additive `tasklists` write commands sourced directly from the OpenAPI:

1. `freelo tasklists create --project <id> --name <str> [--budget <str>] [--dry-run]` against `POST /project/{project_id}/tasklists` (yaml :1140-1178).
2. `freelo tasklists create-from-template <template_id> --source-tasklist <id> [--target-project <id>] [--target-tasklist <id>] [--date-start <YYYY-MM-DD>] [--worker <id>]... [--dry-run]` against `POST /tasklist/create-from-template/{template_id}` (yaml :1290-1358).

`tasklists delete` is **dropped from this slice** — `DELETE /tasklist/{id}` is not documented in `docs/api/freelo-api.yaml` as of 2026-05-09. Deferred to R34.5 pending a `freelo-api-specialist` probe (mirrors R29.5/R33.5 deferral pattern).

Two new envelope schemas: `freelo.tasklists.create/v1`, `freelo.tasklists.create-from-template/v1`. Additive only — no breaking changes.

## 1. Endpoints (verified against OpenAPI)

### 1.1 `POST /project/{project_id}/tasklists` (yaml :1140-1178)

Body:

```jsonc
{
  "name": "string (required)",
  "budget": "string, stringified currency e.g. \"100000\" = 1000.00 (optional)"
}
```

Response: `TasklistWithBudget` = `TasklistBasic` (`id`, `name`) + `budget?: Currency` (yaml :5083-5089).

Notes:
- Permission: project manager or higher (yaml :1153). 403 with `AclForbiddenException` / `RoleActionForbiddenException` otherwise.
- `budget` units: a stringified integer where the **last two digits are decimals** ("100000" → 1000.00 of the project's currency). The CLI accepts the string verbatim; no client-side parsing of the decimal separator.

### 1.2 `POST /tasklist/create-from-template/{template_id}` (yaml :1290-1358)

Body:

```jsonc
{
  "tasklist_id": "integer (required) — source tasklist id INSIDE the template project",
  "target_project_id": "integer (optional)",
  "target_tasklist_id": "integer (optional)",
  "preset_date_from": "string YYYY-MM-DD (optional)",
  "users_ids": "integer[] (optional)"
}
```

Response (yaml :1339-1358):

```jsonc
{
  "id": "integer",
  "name": "string",
  "tasks": [{ "id": "integer", "name": "string" }]
}
```

Behavior notes (yaml :1302-1307):
- `tasklist_id` is the source tasklist inside the template referenced by path `template_id` (the path/body ID interleaving is deliberate).
- If `target_project_id` is omitted, a new project is created.
- If both `target_project_id` and `target_tasklist_id` are set, tasks are copied into that existing tasklist instead of a fresh one.
- `preset_date_from` shifts floating due-dates relative to this date — same semantics as R31's `--date-start` for `POST /project/create-from-template` (`preset_date_from`).
- `users_ids` must be a subset of the template's members.

### 1.3 `DELETE /tasklist/{id}` — **NOT DOCUMENTED**

Not present in `docs/api/freelo-api.yaml`. Deferred to R34.5; see roadmap insertion in §8.

## 2. CLI surface

### 2.1 `freelo tasklists create`

```
freelo tasklists create --project <id> --name <str> [--budget <str>] [--dry-run]
```

| Flag | Type | Required | Maps to | Notes |
|---|---|---|---|---|
| `--project <id>` | positive integer | yes | path `{project_id}` | Validated client-side |
| `--name <str>` | non-empty string | yes | body `name` | Trimmed; whitespace-only rejects with exit 2 |
| `--budget <str>` | numeric string `[0-9]+` | no | body `budget` | Verbatim passthrough; format docs in help |
| `--dry-run` | flag | no | — | Skip POST, echo `would.body` |

Decision 1: `--project` is a flag (not a positional) to mirror `freelo tasks create --tasklist <id>` and `freelo projects workers list --project <id>`.

Decision 2: `--budget` is a string (not a number). Freelo's documented format ("100000" = 1000.00) is base-units-as-string; converting client-side risks float drift. Reject obvious bad input (anything not matching `^[0-9]+$`) with exit 2.

### 2.2 `freelo tasklists create-from-template`

```
freelo tasklists create-from-template <template_id> --source-tasklist <id> [--target-project <id>] [--target-tasklist <id>] [--date-start <YYYY-MM-DD>] [--worker <id>]... [--dry-run]
```

| Flag/Arg | Type | Required | Maps to | Notes |
|---|---|---|---|---|
| `<template_id>` | positive integer | yes | path `{template_id}` | The source project template |
| `--source-tasklist <id>` | positive integer | yes | body `tasklist_id` | The source tasklist INSIDE the template. Long-named for clarity vs. `--target-tasklist`. |
| `--target-project <id>` | positive integer | no | body `target_project_id` | Omit → new project created |
| `--target-tasklist <id>` | positive integer | no | body `target_tasklist_id` | Only meaningful with `--target-project`; CLI does NOT enforce that combination — server-side validation owns the rule |
| `--date-start <YYYY-MM-DD>` | ISO-8601 date | no | body `preset_date_from` | Same flag name as R31. Validated by regex + `Date.parse` round-trip. |
| `--worker <id>` | positive integer, repeatable | no | body `users_ids` | Repeatable. Same parser pattern as R31. |
| `--dry-run` | flag | no | — | Skip POST, echo `would.body` |

Decision 3: Use `--source-tasklist` (not `--tasklist-id`, not `--tasklist`). Two reasons:
- Distinguishes from `--target-tasklist`.
- Mirrors the documented body-field semantics ("source tasklist inside the template").

Decision 4: Date flag is `--date-start` (matches R31), not `--preset-date-from` (mirror of wire field). The CLI is for users; the wire field name is irrelevant to flag UX.

## 3. Envelope schemas

### 3.1 `freelo.tasklists.create/v1`

Live success:

```jsonc
{
  "schema": "freelo.tasklists.create/v1",
  "data": {
    "project_id": 100,
    "tasklist": { "id": 9001, "name": "QA checklist", "budget": { "amount": "100000", "currency": "CZK" } }
  },
  "rate_limit": {...}
}
```

Dry-run:

```jsonc
{
  "schema": "freelo.tasklists.create/v1",
  "dry_run": true,
  "data": {
    "project_id": 100,
    "would": {
      "method": "POST",
      "path": "/project/100/tasklists",
      "body": { "name": "QA checklist", "budget": "100000" }
    }
  }
}
```

`data.tasklist` shape: `TasklistWithBudget` (`{ id, name, budget? }`). Carry `project_id` at the top level so agents can round-trip without scraping the path.

### 3.2 `freelo.tasklists.create-from-template/v1`

Live success:

```jsonc
{
  "schema": "freelo.tasklists.create-from-template/v1",
  "data": {
    "template_id": 50,
    "tasklist": { "id": 9002, "name": "QA checklist", "tasks": [{ "id": 100, "name": "Smoke test" }] }
  },
  "rate_limit": {...}
}
```

Dry-run:

```jsonc
{
  "schema": "freelo.tasklists.create-from-template/v1",
  "dry_run": true,
  "data": {
    "template_id": 50,
    "would": {
      "method": "POST",
      "path": "/tasklist/create-from-template/50",
      "body": { "tasklist_id": 7, "target_project_id": 100, "preset_date_from": "2026-09-01", "users_ids": [42] }
    }
  }
}
```

## 4. Errors and exit codes

| Trigger | Exit | Code |
|---|---|---|
| Missing/empty/invalid required flag | 2 | `VALIDATION_ERROR` |
| HTTP 400 (server-side validation) | 4 | `FREELO_API_ERROR` (with hint based on `errors[]`) |
| HTTP 401 | 3 | `AUTH_EXPIRED` |
| HTTP 403 | 4 | `FORBIDDEN` (with permission hint) |
| HTTP 404 (template/project not found) | 4 | `FREELO_API_ERROR` (template-not-found hint for create-from-template) |
| HTTP 422 | 4 | `FREELO_API_ERROR` |
| HTTP 429 | 6 | `RATE_LIMITED` |
| HTTP 5xx | 4 | `SERVER_ERROR` |
| Network | 5 | `NETWORK_ERROR` |

Hint rewriter for `tasklists create`:
- 400: generic "Server-side validation rejected the request" hint.
- 403: "Account does not have permission to create tasklists in this project."

Hint rewriter for `tasklists create-from-template`:
- 400 + `users_ids` mention → "Worker ids must be members of the template."
- 400 + `target_project_id` mention → "target project id must reference a project the caller can access."
- 400 generic → server-side validation hint.
- 403 → permission hint.
- 404 → "Template not found. Run `freelo projects list --scope templates` to list valid ids."

## 5. Implementation outline

### 5.1 Schemas (`src/api/schemas/tasklist.ts` — append, do not new-file)

- Reuse the existing `CurrencySchema` (already inlined).
- Add `TasklistWithBudgetSchema` (`{ id, name, budget?: Currency }`).
- Add `TasklistFromTemplateSchema` (`{ id, name, tasks: { id, name }[] }`).
- Add types `CreateTasklistInput`, `CreateTasklistBody`, `TasklistsCreateData`.
- Add types `CreateTasklistFromTemplateInput`, `CreateTasklistFromTemplateBody`, `TasklistsCreateFromTemplateData`.

### 5.2 API client

- `src/api/tasklists-create.ts` — `buildCreateTasklistBody`, `createTasklist`, `createTasklistPath(projectId)`.
- `src/api/tasklists-create-from-template.ts` — `buildCreateTasklistFromTemplateBody`, `createTasklistFromTemplate`, `createTasklistFromTemplatePath(templateId)`.

### 5.3 Commands

- `src/commands/tasklists/create.ts` — register `create` leaf.
- `src/commands/tasklists/create-from-template.ts` — register `create-from-template` leaf.
- Update `src/commands/tasklists.ts` to register both.

### 5.4 Human renderers

- `src/ui/human/tasklists-create.ts` — live + dry-run lines.
- `src/ui/human/tasklists-create-from-template.ts` — live + dry-run lines.

### 5.5 Tests

- `test/commands/tasklists/create.test.ts` — happy path, dry-run, every error class, body capture, introspect.
- `test/commands/tasklists/create-from-template.test.ts` — same matrix.
- `test/msw/handlers.ts` — append `tasklistsCreateHandlers` and `tasklistsCreateFromTemplateHandlers` factories.
- `test/fixtures/tasklists/create-9001.json`, `test/fixtures/tasklists/create-from-template-9002.json`.

### 5.6 Docs

- `docs/commands/tasklists-create.md`.
- `docs/commands/tasklists-create-from-template.md`.

### 5.7 Roadmap update (`docs/roadmap.md`)

- Annotate existing R34 line: scope narrowed to two creates; delete deferred to R34.5.
- Insert R34.5 entry below R34: outcome `freelo tasklists delete <id> [--yes]`; status Blocked on Freelo API confirmation; depends on R34, R13 + OpenAPI confirmation; first action `freelo-api-specialist`.

### 5.8 Changeset

- Minor bump (additive).
- Two new envelope schemas listed.

## 6. Decisions log entries

1. **Drop `tasklists delete` from this slice** — OpenAPI authoritative; mirror R29/R33 deferral pattern. (orchestrator + human)
2. **Flag set for create-from-template designed from documented body, not roadmap surface** — roadmap predates OpenAPI verification. (architect)
3. **`--source-tasklist` flag name** — alternatives: `--tasklist-id` (rejected: ambiguous w/ `--target-tasklist`), `--from-tasklist` (rejected: less explicit). (architect)
4. **`--budget` is a verbatim string, not parsed** — Freelo's "100000 = 1000.00" base-units-as-string convention; client-side parsing risks float drift. Validate `^[0-9]+$` only. (architect)
5. **Carry `project_id` / `template_id` at top of envelope `data`** — agents shouldn't have to scrape the wire path. (architect)

## 7. Open questions

None. Spec is complete given the OpenAPI contract.

## 8. Plan

### 8.1 Files to create/modify

- **Modify** `src/api/schemas/tasklist.ts` — append R34 type block (one block).
- **Create** `src/api/tasklists-create.ts`.
- **Create** `src/api/tasklists-create-from-template.ts`.
- **Create** `src/commands/tasklists/create.ts`.
- **Create** `src/commands/tasklists/create-from-template.ts`.
- **Modify** `src/commands/tasklists.ts` — register both new leaves.
- **Create** `src/ui/human/tasklists-create.ts`.
- **Create** `src/ui/human/tasklists-create-from-template.ts`.
- **Modify** `test/msw/handlers.ts` — append two handler factories.
- **Create** `test/fixtures/tasklists/create-9001.json`.
- **Create** `test/fixtures/tasklists/create-from-template-9002.json`.
- **Create** `test/commands/tasklists/create.test.ts`.
- **Create** `test/commands/tasklists/create-from-template.test.ts`.
- **Create** `docs/commands/tasklists-create.md`.
- **Create** `docs/commands/tasklists-create-from-template.md`.
- **Modify** `docs/roadmap.md` — annotate R34, insert R34.5.
- **Create** `.changeset/<auto>.md` — minor bump.

### 8.2 No new dependencies

All implementation reuses existing primitives (`zod`, `commander`, `undici`, MSW, etc.).

### 8.3 Pre-commit gate

```
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm fix:readme && pnpm check:readme
```

with `pnpm build` immediately before `fix:readme`/`check:readme`, no source edits in between (Calibration §3).
