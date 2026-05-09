# 0042 — `freelo projects create` (R29)

**Status:** Accepted — ready for implementation
**Run:** 2026-05-09-0530-projects-create
**Tier:** Yellow (additive new command + new envelope schema; no auth/HTTP-default changes; no new deps)
**Branch:** `feat/projects-create`
**Cross-reference:** Patterns inherited from spec 0019 (R09 `tasks create` — first write slice, ships shared write infra). API endpoint is the documented `POST /projects` (OpenAPI :189-234).

---

## 1. Problem

Wave 5 opens the project-admin surface. Up to R28 the CLI can read every project in every scope and write the entire task / comment / time / file / label / notification surface — but a user still has to log into the web UI to *create* a project. R29 closes that gap with a one-line agent-driven primitive:

```
FREELO_API_KEY=*** FREELO_EMAIL=*** \
  freelo projects create --name "Q3 onboarding" --currency EUR --output json
```

It is the **first slice of Wave 5** but **not** the first write slice — Wave 2 already shipped the shared write infra (`src/lib/dry-run.ts`, `src/lib/batch.ts`, `--dry-run`, NDJSON streamer, idempotency helper, confirm helper). R29 is a thin command on top of that infra.

## 2. Background — what the API gives us

**Endpoint:** `POST /projects` — `createProject` (OpenAPI :189-234, verified 2026-05-09).

**Request body** (OpenAPI :206-227):

| Field | Type | Required | CLI flag |
|---|---|---|---|
| `name` | string | **yes** | `--name <str>` |
| `currency_iso` | enum `CZK|EUR|USD` | **yes** | `--currency <code>` |
| `project_owner_id` | integer | no | `--project-owner-id <id>` |

**Response** (OpenAPI :228-234): `ProjectBasic` — `{ id, name }` (yaml :4944-4950).

**Side effects** (OpenAPI :201-204): business-account captains are auto-invited as commanders/workers; emits `project_owner_assigner` and `project_commander_promote` events. If `project_owner_id` is invalid, server returns 400 (`project_owner_id X is not valid`).

### 2.1 Reconciliation with the roadmap line

The roadmap says:
```
freelo projects create --name <str> [--date-start YYYY-MM-DD] [--currency <code>] [--project-owner-id <id>]
```

Reconciled against the OpenAPI (which is authoritative — orchestrator hard rule "API behavior not in `docs/api/freelo-api.yaml` → pause / don't guess"):

- **`--date-start` is dropped** in v1. The documented body has no `date_start` (or any other start-date) field. Same precedent as spec 0032 §R20 dropping `--note` from `time stop` because the documented body had no `note`. Tracked as a follow-up R29.5 if Freelo adds the field. Decision 1.
- **`--currency` is required, not optional.** The OpenAPI marks `currency_iso` required; making the CLI flag optional and silently picking a default would diverge from the wire contract on every invocation. We surface the API rule directly. Decision 2.
- **`--project-owner-id` stays optional** — matches the OpenAPI; when omitted the authenticated caller is the owner.
- **No `--stdin` batch in v1.** Project creation is rare and consequential; a single-shot surface is correct first. Defer NDJSON to a follow-up if demand surfaces. Decision 3.

## 3. Proposal

### 3.1 Subcommand signature

```
freelo projects create
  --name <str>                     # required; free text
  --currency <code>                # required; one of CZK, EUR, USD
  [--project-owner-id <id>]        # numeric user id; omitted = caller is owner
  [--dry-run]                      # no HTTP call; envelope echoes the body that *would* go on the wire
```

**Per-command `meta`:**

```ts
export const meta: CommandMeta = {
  outputSchema: 'freelo.projects.create/v1',
  destructive: false,
};
```

`destructive: false` — create is additive. Idempotency for create is **not** automatic (POSTing the same body twice yields two projects). We do not invent a synthetic idempotency key in v1.

### 3.2 Envelope shape — `freelo.projects.create/v1`

Live success:

```jsonc
{
  "schema": "freelo.projects.create/v1",
  "data": {
    "project": { "id": 9001, "name": "Q3 onboarding" }
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-05-09T20:30:00Z" },
  "request_id": "..."
}
```

`--dry-run`:

```jsonc
{
  "schema": "freelo.projects.create/v1",
  "dry_run": true,
  "data": {
    "would": {
      "method": "POST",
      "path": "/projects",
      "body": { "name": "Q3 onboarding", "currency_iso": "EUR" }
    }
  }
}
```

No `rate_limit`, no `request_id` on dry-run. The `dry_run: true` flag is a top-level envelope discriminant agents key off (already in `Envelope<T>`).

### 3.3 Field naming and rules

- Snake-case on the wire (`currency_iso`, `project_owner_id`); kebab-case on the CLI (`--currency`, `--project-owner-id`).
- `data.project` is the parsed `ProjectBasic` shape (`{ id, name }`). Schema uses `.passthrough()` (project-wide convention) — Freelo may add fields and we tolerate them.
- Top-level keys agents may key off: `schema`, `data.project.id` (the new project's id), `dry_run`. None are removed/renamed in subsequent v1 revisions; new fields are additive only (working agreement: "Envelope schemas are a public contract").

### 3.4 Example invocations

**Human (TTY) — minimal:**
```bash
$ freelo projects create --name "Q3 onboarding" --currency EUR
Created project #9001 (Q3 onboarding).
```

**Agent — JSON, env-var auth:**
```bash
$ FREELO_API_KEY=*** FREELO_EMAIL=bot@example.com \
  freelo projects create --name "Q3 onboarding" --currency EUR --output json
{"schema":"freelo.projects.create/v1","data":{"project":{"id":9001,"name":"Q3 onboarding"}},"rate_limit":{...}}
```

**With explicit owner:**
```bash
$ freelo projects create --name "Acme migration" --currency CZK --project-owner-id 314
Created project #9002 (Acme migration).
```

**Dry-run:**
```bash
$ freelo projects create --name "Test" --currency USD --dry-run --output json
{"schema":"freelo.projects.create/v1","dry_run":true,"data":{"would":{"method":"POST","path":"/projects","body":{"name":"Test","currency_iso":"USD"}}}}
```

**Error (invalid owner):**
```bash
$ freelo projects create --name "X" --currency EUR --project-owner-id 999
freelo: project_owner_id 999 is not valid
  hint: Confirm the user id; the owner must be an owner-eligible user in your account.
$ echo $?
4
```

## 4. Errors

Every typed error class triggered by R29 has an exit-code-asserting test (calibration §2).

| Trigger | Class | code | exitCode | retryable | hint_next |
|---|---|---|---|---|---|
| Missing `--name` | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--name is required (project name)." |
| Empty `--name` | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--name cannot be empty." |
| Missing `--currency` | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--currency is required: one of CZK, EUR, USD." |
| `--currency` not in enum | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--currency must be one of: CZK, EUR, USD." |
| `--project-owner-id` not positive integer | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--project-owner-id is the numeric user id." |
| HTTP 400 (server-side validation, e.g. invalid owner) | `FreeloApiError` | `FREELO_API_ERROR` | 4 | false | "Confirm the user id; the owner must be an owner-eligible user in your account." (when message contains `project_owner_id`) — else server message passed through |
| HTTP 401 | `FreeloApiError` (auth-expired path) | `AUTH_EXPIRED` | 3 | false | "Re-authenticate with `freelo auth login`." |
| HTTP 403 | `FreeloApiError` | `FORBIDDEN` | 4 | false | "Account does not have permission to create projects." |
| HTTP 422 | `FreeloApiError` | `FREELO_API_ERROR` | 4 | false | server message passed through |
| HTTP 429 | `RateLimitedError` | `RATE_LIMITED` | 6 | true | "Retry after `retry_after` seconds." |
| HTTP 5xx | `FreeloApiError` | `FREELO_API_ERROR` | 4 | true | "Retry; if it persists, check Freelo status." |
| Network failure | `NetworkError` | `NETWORK_ERROR` | 5 | true | (existing) |

## 5. Data model — zod schemas

Add to `src/api/schemas/project.ts`:

```ts
/**
 * `ProjectBasic` per OpenAPI :4944-4950 — the response shape of `POST /projects`.
 * Minimal: just `id` and `name`. `.passthrough()` so Freelo can add fields
 * and we tolerate them.
 */
export const ProjectBasicSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
  })
  .passthrough();

export type ProjectBasic = z.infer<typeof ProjectBasicSchema>;

// Body-builder input (CLI-side type, not from wire):
export type CreateProjectInput = {
  name: string;
  currency: 'CZK' | 'EUR' | 'USD';
  projectOwnerId?: number;
};

export type CreateProjectBody = {
  name: string;
  currency_iso: 'CZK' | 'EUR' | 'USD';
  project_owner_id?: number;
};

/** Envelope `data` shape for `freelo.projects.create/v1`. */
export type ProjectsCreateData = {
  project?: ProjectBasic; // present on live success
  would?: {
    method: 'POST';
    path: '/projects';
    body: CreateProjectBody;
  }; // present on --dry-run
};
```

Wrapper module `src/api/projects-create.ts` (new file — mirrors `src/api/tasks-create.ts`):

```ts
export function buildCreateProjectBody(input: CreateProjectInput): CreateProjectBody { ... }
export async function createProject(client, opts): Promise<{ project: ProjectBasic; raw: ApiResponse<ProjectBasic> }> { ... }
export const createProjectPath = '/projects' as const;
```

`buildCreateProjectBody` is a pure function — easy to unit-test without MSW.

## 6. Edge cases

- **`--name` whitespace-only**: rejected with `ValidationError` (empty after trim). Decision 4.
- **`--currency` lowercase**: accepted and uppercased before validation (e.g. `--currency eur` → wire `EUR`). Common typo; ergonomic. Decision 5.
- **`--project-owner-id 0`**: rejected with `ValidationError` (positive integer required).
- **Repeated flag** (e.g. `--name "A" --name "B"`): Commander semantics — last value wins. We do not special-case.
- **Dry-run with all flags** including `--project-owner-id`: emitted into the `would.body` so the dry-run is accurate.
- **No paging**: writes don't paginate. Field absent from envelope.
- **No batch / `--stdin`**: out of scope for v1 (decision 3).

## 7. Non-goals (R29 explicit out-of-scope)

- `--date-start` flag (deferred — not in OpenAPI body; decision 1 / future R29.5).
- `--stdin` / NDJSON batch input (decision 3).
- Idempotency keys (create is non-idempotent by definition).
- Discoverability sub-flags (`--currency` enum is small enough that the help text is the discovery surface).
- Project deletion / archiving / activation (R30).
- Create-from-template (R31).
- Custom-field defaults on the new project (Wave 7).

## 8. Open questions

None. Every scope-affecting question above is resolved as a logged decision (decisions 1–5).

## 9. Decisions log (autonomous)

1. **`--date-start` dropped from R29.** The OpenAPI `POST /projects` body has no start-date field. Following the orchestrator hard rule: don't guess the API. Tracked as future R29.5.
2. **`--currency` required (not optional).** The OpenAPI marks `currency_iso` required. Making the CLI flag optional with a default would diverge silently. Surface the rule.
3. **No `--stdin` / NDJSON batch in v1.** Project creation is rare; single-shot is correct first. Add later if demand surfaces.
4. **`--name` trimmed; whitespace-only rejected.** Common typo case; rejecting early gives a clear error vs. an opaque server-side one.
5. **`--currency` lowercase accepted, uppercased on the way in.** Ergonomic; the wire format is uppercase per OpenAPI enum.

(Decisions are written individually to `docs/decisions/2026-05-09-0530-projects-create-N-...md` files for auditability.)

---

## Plan

> **Plan rule:** the plan is the contract. If implementation deviates, update the plan first.

### 10. File-level TODOs

#### New files

1. **`src/api/projects-create.ts`** — new wrapper, mirrors `src/api/tasks-create.ts`:
   - `buildCreateProjectBody(input: CreateProjectInput): CreateProjectBody`
   - `createProject(client, opts): Promise<{ project: ProjectBasic; raw: ApiResponse<ProjectBasic> }>`
   - `export const createProjectPath = '/projects' as const`
2. **`src/commands/projects/create.ts`** — Commander leaf. Mirrors structural shape of `src/commands/projects/show.ts` but for a write. Owns:
   - flag parsing & validation (synchronous, before any HTTP call)
   - body builder call
   - dry-run vs. live envelope build (uses `dryRunEnvelope` from `src/lib/dry-run.ts`)
   - human renderer call
3. **`src/ui/human/projects-create.ts`** — single-project human renderer:
   - Live: `Created project #9001 (Q3 onboarding).`
   - Dry-run: `(dry-run) Would create project "Q3 onboarding" (currency: EUR).`
4. **`test/commands/projects/create.test.ts`** — vitest + MSW. One named test per row:
   - happy path: minimal flags (`--name`, `--currency`) → JSON envelope, schema, exit 0
   - happy path: every flag set, body builder output asserted on the wire (incl. `project_owner_id`)
   - happy path: human-mode rendering snapshot
   - happy path: `--currency eur` (lowercase) is accepted and uppercased on the wire
   - dry-run: no HTTP at all; envelope carries `dry_run: true` + `would`
   - dry-run + `--project-owner-id`: `would.body.project_owner_id` is set
   - validation: missing `--name` → `VALIDATION_ERROR` exit 2
   - validation: empty `--name` (whitespace-only) → exit 2
   - validation: missing `--currency` → exit 2
   - validation: bad `--currency` (e.g. `--currency GBP`) → exit 2
   - validation: `--project-owner-id 0` → exit 2
   - validation: `--project-owner-id abc` → exit 2
   - api: 400 (invalid owner) → `FREELO_API_ERROR` exit 4, hint mentions owner
   - api: 401 → `AUTH_EXPIRED` exit 3
   - api: 403 → `FORBIDDEN` exit 4
   - api: 422 → `FREELO_API_ERROR` exit 4
   - api: 429 → `RATE_LIMITED` exit 6, retryable: true
   - api: 5xx → `FREELO_API_ERROR` exit 4
   - network: `HttpResponse.error()` → `NETWORK_ERROR` exit 5
   - introspect: `freelo --introspect` includes `projects create` with `output_schema: 'freelo.projects.create/v1'`, `destructive: false`

5. **`test/api/projects-create.test.ts`** — pure unit test for `buildCreateProjectBody` (uppercasing, optional-field omission, owner integer flow).

6. **`test/fixtures/projects/create-9001.json`** — scrubbed `ProjectBasic` response.

7. **`docs/commands/projects-create.md`** — VitePress page: synopsis, flags, two real-world examples, link to envelope schema, note about ownership semantics + dropped `--date-start`.

8. **`.changeset/<random-hash>.md`** — `freelo-cli: minor` — "Add `freelo projects create` (R29). New envelope schema `freelo.projects.create/v1` (additive — public contract). Reuses Wave 2 shared write infra (`--dry-run`)."

#### Modified files

9. **`src/api/schemas/project.ts`** — append `ProjectBasicSchema`, `CreateProjectInput`, `CreateProjectBody`, `ProjectsCreateData` types. No changes to existing R03 / R04 types.
10. **`src/commands/projects.ts`** — register the new `create` leaf (one new line + one import).
11. **`test/msw/handlers.ts`** — append `projectsCreateHandlers` factory namespace (mirrors `tasksCreateHandlers`):
    - `ok(body)` — 200 with the supplied body
    - `okWhenBody(predicate, response)` — match-on-body
    - `unauthorized()` — 401
    - `forbidden()` — 403
    - `unprocessable(message?)` — 422
    - `badRequest(message)` — 400 (used for the invalid-owner test)
    - `rateLimited()` — 429
    - `serverError(status?)` — 5xx
    - `networkError()` — `HttpResponse.error()`
12. **`README.md`** — autogen Commands block — regenerated by `pnpm fix:readme` in the doc phase. **Do not hand-edit.**
13. **`docs/specs/0042-projects-create.md`** — this file.
14. **`docs/roadmap.md`** — append a "✅ shipped" tick to R29 entry **after** PR is merged (not in this PR).

#### No-touch (paranoia checklist)

- `src/config/**` — none.
- `src/api/client.ts` — none.
- `src/bin/freelo.ts` — none.
- `src/errors/*` — no new error classes (every case maps to existing classes per §4).
- `src/lib/dry-run.ts`, `src/lib/batch.ts`, `src/lib/idempotency.ts`, `src/lib/confirm.ts` — reused unchanged.

### 11. Dependencies

**No new runtime deps. No new dev deps.** `zod`, `commander`, `undici` (via `client.ts`) cover the surface.

### 12. Test strategy

- **Unit** layer: `buildCreateProjectBody` in `test/api/projects-create.test.ts`. No I/O, no MSW, no Commander. Fast.
- **Integration** layer: `test/commands/projects/create.test.ts` boots the program end-to-end with MSW handlers. Asserts: stdout content (envelope shape), exit code, MSW-recorded request body for the POST.
- **Coverage targets** (project-wide thresholds in `vitest.config.ts`): 80% lines / 90% on `src/api/` and `src/commands/`.
- **Calibration §2**: every error class triggered (`ValidationError`, `FreeloApiError`, `RateLimitedError`, `NetworkError`) has at least one exit-code-asserting test.

### 13. Slicing

R29 is one slice (~250 LOC including tests). No need to subdivide.

### 14. Implementation order

1. Add `ProjectBasicSchema` + types to `src/api/schemas/project.ts` (no logic — just shape).
2. Write `src/api/projects-create.ts`. Unit-test the body builder.
3. Append `projectsCreateHandlers` to `test/msw/handlers.ts`.
4. Write `src/ui/human/projects-create.ts`.
5. Write `src/commands/projects/create.ts`. Integration-test against MSW.
6. Wire into `src/commands/projects.ts`.
7. `pnpm typecheck && pnpm lint && pnpm test --coverage && pnpm build && pnpm check:readme` on a clean tree (calibration §3).
8. Add changeset, regen README via `pnpm fix:readme`, commit, push, open PR.

### 15. Risk callouts for the implementer

- **Calibration §1** — when interrupted, run **every** remaining phase before pushing. No shortcut.
- **Calibration §2** — every typed error class in §4 must have an exit-code-asserting test.
- **Calibration §3** — gates run on the **committed** tree post-commit, not the working tree.
- **Calibration §6** — branch from a clean `main`, not from whatever HEAD happens to be.
- **`--currency` is the most likely user error** (e.g. `--currency GBP`). The validation message must list the three accepted codes.
- **OpenAPI fidelity** — the only fields on the wire are `name`, `currency_iso`, `project_owner_id`. Do not add anything else; do not omit `currency_iso`.

ARCHITECT run=2026-05-09-0530-projects-create status=ok spec=docs/specs/0042-projects-create.md open_questions=0 new_deps=0
