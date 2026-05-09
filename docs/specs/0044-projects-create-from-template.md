# 0044 — `freelo projects create-from-template` (R31)

**Status:** Accepted — ready for implementation
**Run:** 2026-05-09-1101-r31-projects-create-from-template
**Tier:** Yellow (additive new command + new envelope schema; no auth/HTTP-default changes; no new deps)
**Branch:** `feat/projects-create-from-template`
**Cross-reference:** Patterns inherited from spec 0042 (R29 `projects create` — sibling write; copy-paste body builder, validation, hint-rewriter, dry-run, MSW handler factories). Scope and shape are identical; the differences are flags, body shape, and path.

---

## 1. Problem

Wave 5 third slice. R29 lets users create a blank project; R30 archives/activates/deletes. R31 closes the templating loop: spin up a new project from a saved template (state_id=3) without leaving the terminal.

```
FREELO_API_KEY=*** FREELO_EMAIL=*** \
  freelo projects create-from-template 4567 --name "Acme onboarding 2026-Q3" --output json
```

This is a thin command on top of infra already shipped: HTTP client (R01), envelope (R01), `--dry-run` helper (R09), error taxonomy (R01).

## 2. Background — what the API gives us

**Endpoint:** `POST /project/create-from-template/{template_id}` — `createProjectFromTemplate` (OpenAPI :759-830, verified 2026-05-09).

**Path param:** `template_id` (integer, required).

**Request body** (OpenAPI :785-814) — every property optional in the OpenAPI:

| Field | Type | OpenAPI required | CLI flag | CLI required |
|---|---|---|---|---|
| `name` | string | no | `--name <str>` | **yes** |
| `project_owner_id` | integer | no | `--owner-id <id>` | no |
| `currency_iso` | enum `CZK|EUR|USD` | no | `--currency <code>` | no |
| `preset_date_from` | string (date `YYYY-MM-DD`) | no | `--date-start <YYYY-MM-DD>` | no |
| `general_settings.layout` | enum `rows|kanban` (default `rows`) | no | `--layout <rows|kanban>` | no |
| `users_ids` | array of integer | no | `--worker <id>` (repeatable) | no |

**Response** (OpenAPI :816-830):

```yaml
{ id, name, owner: UserBasic, currency_iso }
```

Richer than `POST /projects` (which returns only `{id, name}`) — owner and currency_iso come back too.

**Behavior notes from the OpenAPI description (yaml :772-777):**
- `currency_iso` omitted ⇒ server derives from caller locale. Pass it explicitly for predictable agent output.
- `project_owner_id` defaults to the authenticated caller; invalid id ⇒ 400 `InvalidArgumentException`.
- `preset_date_from` shifts floating "+N days" template due dates to absolute dates anchored at this value.
- `users_ids` is validated against the **template's** member list, not arbitrary users — invalid ids ⇒ 400.
- `name` defaults to the template's name; we override by requiring `--name` at the CLI for predictability.

### 2.1 Reconciliation with the roadmap line

Roadmap (`docs/roadmap.md` :549):

```
freelo projects create-from-template <template_id> --name <str> [--date-start …] [--worker <id>]...
```

Reconciled against the OpenAPI:

- **`--name` required at the CLI** (server allows omission, server defaults to template name). Predictable output for agents > saving five characters of typing. Decision 1.
- **`--date-start`** maps to documented `preset_date_from` (yaml :799-802). Format: `YYYY-MM-DD`. KEEP. Unlike R29 (where the documented `POST /projects` body had no start-date field), the create-from-template body explicitly defines `preset_date_from`. Decision 2.
- **`--worker <id>` (repeatable)** maps to documented `users_ids` (yaml :810-814). KEEP. Note: server validates against the template's member list — out-of-template ids ⇒ 400. CLI passes through, lets server enforce.
- **`--currency` optional**, not required. Different from R29 because the create-from-template body marks `currency_iso` *optional* with a documented locale-derived fallback. Surfacing the API rule as-is. Decision 3.
- **`--owner-id` optional** — same shape as R29's `--project-owner-id`. Renamed to `--owner-id` for brevity in this command (R29's flag is unchanged); both target the same wire field `project_owner_id`. Decision 4.
- **`--layout`** added: documented enum, two values, smallest possible flag surface. Decision 5.
- **No `--stdin` batch in v1.** Project creation is rare. Same precedent as R29 spec 0042 decision 3.

## 3. Proposal

### 3.1 Subcommand signature

```
freelo projects create-from-template <template_id>
  --name <str>                     # required; new project name
  [--owner-id <id>]                # numeric user id; omitted = caller is owner
  [--currency <code>]              # one of CZK, EUR, USD; omitted = server-derived
  [--date-start <YYYY-MM-DD>]      # anchor for floating template due dates
  [--layout <rows|kanban>]         # board layout for the new project; default rows
  [--worker <id>]                  # repeatable; user ids from the template's member list
  [--dry-run]                      # no HTTP call; envelope echoes the body that *would* go on the wire
```

**Per-command `meta`:**

```ts
export const meta: CommandMeta = {
  outputSchema: 'freelo.projects.create-from-template/v1',
  destructive: false,
};
```

`destructive: false` — additive. No idempotency (POSTing twice yields two projects).

### 3.2 Envelope shape — `freelo.projects.create-from-template/v1`

Live success:

```jsonc
{
  "schema": "freelo.projects.create-from-template/v1",
  "data": {
    "project": {
      "id": 9001,
      "name": "Acme onboarding 2026-Q3",
      "owner": { "id": 314, "fullname": "Jane Doe" },
      "currency_iso": "EUR"
    },
    "template_id": 4567
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-05-09T20:30:00Z" },
  "request_id": "..."
}
```

`--dry-run`:

```jsonc
{
  "schema": "freelo.projects.create-from-template/v1",
  "dry_run": true,
  "data": {
    "template_id": 4567,
    "would": {
      "method": "POST",
      "path": "/project/create-from-template/4567",
      "body": {
        "name": "Acme onboarding 2026-Q3",
        "currency_iso": "EUR",
        "preset_date_from": "2026-09-01",
        "general_settings": { "layout": "kanban" },
        "users_ids": [12, 34]
      }
    }
  }
}
```

`data.template_id` is present in both branches — the path-positional is the most-keyed-off output.

### 3.3 Field naming and rules

- Snake-case wire (`currency_iso`, `project_owner_id`, `preset_date_from`, `users_ids`); kebab-case CLI.
- `data.project` is the parsed response shape: `{ id, name, owner?, currency_iso? }`. New zod schema `ProjectFromTemplateSchema` adds `owner` (`UserBasicSchema.nullable().optional()`) and `currency_iso` (`z.string().nullable().optional()`) to the `ProjectBasic` shape. `.passthrough()`.
- Top-level keys agents may key off: `schema`, `data.project.id`, `data.template_id`, `dry_run`. Public-contract stable.

### 3.4 Example invocations

**Human (TTY) — minimal:**
```bash
$ freelo projects create-from-template 4567 --name "Acme Q3"
Created project #9001 (Acme Q3) from template #4567.
```

**Agent — full flag set:**
```bash
$ FREELO_API_KEY=*** FREELO_EMAIL=bot@example.com \
  freelo projects create-from-template 4567 \
  --name "Acme Q3" --currency EUR --date-start 2026-09-01 \
  --layout kanban --worker 12 --worker 34 --output json
{"schema":"freelo.projects.create-from-template/v1","data":{...},"rate_limit":{...}}
```

**Dry-run:**
```bash
$ freelo projects create-from-template 4567 --name "X" --currency USD --dry-run --output json
{"schema":"freelo.projects.create-from-template/v1","dry_run":true,"data":{"template_id":4567,"would":{...}}}
```

**Error (invalid template):**
```bash
$ freelo projects create-from-template 999 --name "X"
freelo: Template 999 not found.
  hint: Run `freelo projects list --scope templates` to find valid template ids.
$ echo $?
4
```

## 4. Errors

Every typed error class triggered by R31 has an exit-code-asserting test (calibration §2).

| Trigger | Class | code | exitCode | retryable | hint_next |
|---|---|---|---|---|---|
| Missing `<template_id>` arg | Commander → `ValidationError` (re-thrown in action) | `VALIDATION_ERROR` | 2 | false | "<template_id> is the numeric id of the project template (state=3)." |
| `<template_id>` not positive integer | `ValidationError` | `VALIDATION_ERROR` | 2 | false | same |
| Missing `--name` | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--name takes a non-empty new-project name." |
| Empty `--name` (after trim) | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--name takes a non-empty new-project name." |
| `--currency` not in enum | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--currency valid values: CZK, EUR, USD." |
| `--owner-id` not positive integer | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--owner-id is the numeric user id." |
| `--date-start` not `YYYY-MM-DD` | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--date-start must be ISO-8601 calendar date (YYYY-MM-DD)." |
| `--layout` not in enum | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--layout valid values: rows, kanban." |
| `--worker` not positive integer | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--worker is the numeric user id; repeat the flag for multiple." |
| HTTP 400 (server-side: bad owner / bad worker / bad layout) | `FreeloApiError` | `FREELO_API_ERROR` | 4 | false | server message; specialized hint when `project_owner_id` mentioned (mirrors R29) or `users_ids` mentioned ("Worker ids must be members of the template; check `freelo projects show <template>`.") |
| HTTP 401 | `FreeloApiError` (auth path) | `AUTH_EXPIRED` | 3 | false | (existing infra hint) |
| HTTP 403 | `FreeloApiError` | `FORBIDDEN` | 4 | false | "Account does not have permission to use this template." |
| HTTP 404 | `FreeloApiError` | `FREELO_API_ERROR` | 4 | false | "Template not found. Run `freelo projects list --scope templates` to list valid ids." |
| HTTP 422 | `FreeloApiError` | `FREELO_API_ERROR` | 4 | false | server message passed through |
| HTTP 429 | `RateLimitedError` | `RATE_LIMITED` | 6 | true | (existing infra hint) |
| HTTP 5xx | `FreeloApiError` | `SERVER_ERROR` | 4 | true | (existing infra hint) |
| Network failure | `NetworkError` | `NETWORK_ERROR` | 5 | true | (existing) |

## 5. Data model — zod schemas

Add to `src/api/schemas/project.ts` (after the R29/R30 blocks):

```ts
/* ------------------------------------------------------------------------- *
 *  R31 — `freelo projects create-from-template` (spec 0044)
 *
 *  `POST /project/create-from-template/{template_id}` returns a richer shape
 *  than `POST /projects` — id, name, owner, currency_iso (yaml :816-830).
 * ------------------------------------------------------------------------- */

export const ProjectFromTemplateSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    owner: UserBasicSchema.nullable().optional(),
    currency_iso: z.string().nullable().optional(),
  })
  .passthrough();

export type ProjectFromTemplate = z.infer<typeof ProjectFromTemplateSchema>;

export const PROJECT_LAYOUT_VALUES = ['rows', 'kanban'] as const;
export type ProjectLayout = (typeof PROJECT_LAYOUT_VALUES)[number];

/** CLI input shape (camel-case). */
export type CreateProjectFromTemplateInput = {
  templateId: number;
  name: string;
  ownerId?: number;
  currency?: ProjectCurrency;
  dateStart?: string; // YYYY-MM-DD; validated upstream
  layout?: ProjectLayout;
  workers?: readonly number[];
};

/** Wire body shape (snake-case). Optional fields omitted when undefined. */
export type CreateProjectFromTemplateBody = {
  name: string;
  project_owner_id?: number;
  currency_iso?: ProjectCurrency;
  preset_date_from?: string;
  general_settings?: { layout: ProjectLayout };
  users_ids?: number[];
};

/** Envelope `data` shape for `freelo.projects.create-from-template/v1`. */
export type ProjectsCreateFromTemplateData = {
  template_id: number;
  project?: ProjectFromTemplate;
  would?: {
    method: 'POST';
    path: string; // `/project/create-from-template/${template_id}`
    body: CreateProjectFromTemplateBody;
  };
};
```

New file `src/api/projects-create-from-template.ts` (mirrors `src/api/projects-create.ts`):

```ts
export function buildCreateProjectFromTemplateBody(
  input: CreateProjectFromTemplateInput,
): CreateProjectFromTemplateBody { ... }

export function createProjectFromTemplatePath(templateId: number): string {
  return `/project/create-from-template/${templateId}`;
}

export async function createProjectFromTemplate(
  client,
  opts: { templateId: number; body: …; signal?; requestId? },
): Promise<{ project: ProjectFromTemplate; raw: ApiResponse<ProjectFromTemplate> }> { ... }
```

`buildCreateProjectFromTemplateBody` is pure. Edge cases unit-tested without MSW:
- minimal input (only `name`) ⇒ `{ name }` only.
- every field set ⇒ all keys present, snake-cased, with `general_settings.layout` nested.
- empty `workers` array ⇒ `users_ids` field omitted entirely (not `[]`). Matches R09 convention.
- `general_settings` only emitted when `layout` is set.

## 6. Edge cases

- **`<template_id>` 0 / negative / NaN:** `ValidationError` (positive integer).
- **`--name` whitespace-only:** rejected with `ValidationError` after trim. Same as R29.
- **`--currency` lowercase:** accepted, uppercased before validation (R29 precedent, decision 5 of spec 0042).
- **`--date-start` malformed:** rejected by regex `^\d{4}-\d{2}-\d{2}$` plus `Date.parse` finite-check. The wire format is plain ISO date (no time). Decision 6.
- **`--layout` mixed-case:** lowercased before validation (mirrors `--currency` policy; decision 7).
- **`--worker` repeated:** Commander array semantics; each value parsed individually. Duplicates are passed through unchanged (server-side de-dupe is its problem).
- **`--worker` zero values:** when the flag is never given, `users_ids` is omitted (NOT emitted as `[]`).
- **Dry-run with full flag set:** every flag echoed under `would.body`; `general_settings` nested correctly when `--layout` is present.
- **No paging.** Writes don't paginate.
- **No batch / `--stdin`:** out of scope.

## 7. Non-goals (R31 explicit out-of-scope)

- Template discovery flag (`--list-templates`) — covered by `freelo projects list --scope templates` (R03).
- Workers management on the new project (R32).
- Custom-field defaults / per-template overrides (Wave 7).
- Idempotency keys.

## 8. Open questions

None. Every scope-affecting decision is logged below.

## 9. Decisions log (autonomous)

1. **`--name` required at the CLI** even though the server allows omission. Predictable agent output > five characters of typing.
2. **`--date-start` kept** — maps to documented `preset_date_from`. Unlike R29 (`POST /projects` had no date field), this body explicitly defines one.
3. **`--currency` optional** for this command. Server-side default exists (locale-derived); the OpenAPI marks the field optional. Surface the API rule as-is. Different from R29's required `--currency`.
4. **Flag named `--owner-id`, not `--project-owner-id`.** Brevity. R29's `--project-owner-id` is unchanged; we don't rename live flags. Both target wire field `project_owner_id`.
5. **`--layout` added.** Documented enum with default; smallest stable surface.
6. **`--date-start` validated client-side as `YYYY-MM-DD`.** Pre-flight catches typos; server still validates.
7. **`--layout` lowercased before validation.** Mirrors `--currency` ergonomic policy.
8. **No `--stdin` / NDJSON batch in v1.** Same as R29 (project creation is rare).

(Decisions are written individually to `docs/decisions/2026-05-09-1101-r31-projects-create-from-template-N-...md` for auditability.)

---

## Plan

> **Plan rule:** the plan is the contract. If implementation deviates, update the plan first.

### 10. File-level TODOs

#### New files

1. **`src/api/projects-create-from-template.ts`** — wrapper, mirrors `src/api/projects-create.ts`:
   - `buildCreateProjectFromTemplateBody(input): CreateProjectFromTemplateBody` (pure)
   - `createProjectFromTemplatePath(templateId: number): string`
   - `createProjectFromTemplate(client, opts): Promise<{ project, raw }>`
   - Uses `ProjectFromTemplateSchema` for response validation.

2. **`src/commands/projects/create-from-template.ts`** — Commander leaf, mirrors `src/commands/projects/create.ts`:
   - `<template_id>` positional (parsed via `parseTemplateIdArg`)
   - flags: `--name`, `--owner-id`, `--currency`, `--date-start`, `--layout`, `--worker` (repeatable), `--dry-run`
   - `validateFlags()` for required `--name`
   - `runCreateFromTemplate()` with dry-run vs. live branches
   - `rewriteApiHint()` for 400 (owner / workers), 403, 404 cases

3. **`src/ui/human/projects-create-from-template.ts`** — single-project human renderer:
   - Live: `Created project #<id> (<name>) from template #<template_id>.`
   - Dry-run: `(dry-run) Would create project "<name>" from template #<template_id>.` + per-flag indented hints (currency, owner, date-start, layout, workers).

4. **`test/api/projects-create-from-template.test.ts`** — vitest, no MSW. Tests `buildCreateProjectFromTemplateBody` purely.

5. **`test/commands/projects/create-from-template.test.ts`** — vitest + MSW. Mirrors structure of `test/commands/projects/create.test.ts`.

6. **`test/fixtures/projects/create-from-template-9001.json`** — sample success response: `{ id: 9001, name: "Acme Q3", owner: { id: 314, fullname: "Jane" }, currency_iso: "EUR" }`.

7. **`.changeset/r31-projects-create-from-template.md`** — minor changeset.

#### Edited files

8. **`src/api/schemas/project.ts`** — append the R31 block (schemas + types listed in §5).

9. **`src/commands/projects.ts`** — register `registerCreateFromTemplate`.

10. **`test/msw/handlers.ts`** — add `projectsCreateFromTemplateHandlers` factory mirroring `projectsCreateHandlers` but with the templated path. Path: `${API_BASE}/project/create-from-template/${templateId}`.

#### Documentation (R31 follow-up)

11. **`docs/api-reference.md` / `docs/commands.md`** (if they exist as user docs) — append `projects create-from-template`. Doc-writer pass.

### 11. Test plan

**Unit (`test/api/projects-create-from-template.test.ts`)**
- minimal: `{ templateId, name }` → body `{ name }`.
- with `ownerId` → adds `project_owner_id`.
- with `currency` → adds `currency_iso`.
- with `dateStart` → adds `preset_date_from`.
- with `layout` → adds nested `general_settings.layout`.
- with `workers: [12, 34]` → adds `users_ids: [12, 34]`.
- empty `workers: []` → does NOT emit `users_ids`.
- all fields set → full snake-case body shape.
- builder does not emit undefined optional keys.

**End-to-end (`test/commands/projects/create-from-template.test.ts`)** — mirrors R29's test layout:

Happy paths:
- minimal `<id> --name X` → JSON envelope, schema, exit 0, `data.template_id` set.
- every flag set → asserts wire body via `okWhenBody` predicate (snake-case, nested layout, currency uppercased).
- `--currency eur` → wire `EUR` (lowercase ergonomics).
- `--layout KANBAN` → wire `kanban` (lowercase ergonomics).
- `--worker 12 --worker 34` → `users_ids: [12, 34]` in wire body.
- human mode renders `Created project #9001 ... from template #4567`.

Dry-run:
- minimal `--dry-run` → no HTTP, envelope has `dry_run: true`, `data.would.path` matches `/project/create-from-template/<id>`, `data.template_id` set, `data.project` undefined.
- full flags `--dry-run` → `would.body` has `general_settings: { layout: 'kanban' }`, `users_ids: [12, 34]`, `preset_date_from`.
- human dry-run renders `(dry-run) Would create project "X" from template #ID.`

Validation errors (each → exit 2):
- missing `<template_id>` arg.
- `<template_id>` non-numeric.
- `<template_id>` 0.
- missing `--name`.
- whitespace-only `--name`.
- bad `--currency` (e.g. `GBP`).
- `--owner-id 0`.
- `--owner-id abc`.
- `--date-start 2026/09/01` (bad format).
- `--date-start 2026-13-40` (bad calendar values).
- `--layout grid`.
- `--worker 0`.
- `--worker abc`.

API errors (each → asserted code + exit):
- 400 with `project_owner_id ...` → owner-flavored hint, exit 4.
- 400 with `users_ids ...` → workers-flavored hint, exit 4.
- 400 generic → generic hint, exit 4.
- 401 → AUTH_EXPIRED exit 3.
- 403 → FORBIDDEN exit 4 with permission hint.
- 404 → FREELO_API_ERROR exit 4 with template-not-found hint.
- 422 → exit 4.
- 429 → RATE_LIMITED exit 6.
- 5xx → SERVER_ERROR exit 4.
- network error → NETWORK_ERROR exit 5.

Introspection:
- `--introspect` lists `projects create-from-template` with output_schema and destructive=false.

### 12. Out-of-scope safety net

Confirm via grep before commit:
- no calls to `fetch` outside the shared client.
- no top-level imports of `@inquirer/prompts`, `ora`, `chalk`, `boxen` in any new file.
- no new dependencies in `package.json`.

### 13. Commit plan

Single Conventional Commit:
```
feat(commands): projects create-from-template (R31)

Add `freelo projects create-from-template <template_id>` mapping to
`POST /project/create-from-template/{template_id}`. Supports --name,
--owner-id, --currency, --date-start, --layout, --worker (repeatable),
and --dry-run.

New envelope schema: freelo.projects.create-from-template/v1.
```

Changeset: minor.
