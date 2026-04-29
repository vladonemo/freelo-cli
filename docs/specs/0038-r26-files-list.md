# Spec 0038 — `freelo files list` (R26)

**Status:** Draft → Implement
**Run:** 2026-04-29-1756-r26-files-list
**Tier:** Yellow
**Roadmap:** R26 (`docs/roadmap.md:494-498`)
**Depends on:** R25 (`files upload` — adds `src/commands/files.ts` namespace, `src/api/files.ts`, `src/api/schemas/file.ts`), R03 / R16 / R21 (paging precedent: `pagingFromNormalized`, `fetchAllPages`, `PartialPagesError`, `--page`/`--all` mutex), R23 (precedent for deferring an under-supported filter on a list endpoint)

---

## 1. Problem

After R25 (`files upload`) an agent can push a single asset to Freelo and receive a UUID. It still can't enumerate what's already there: agents have no way to discover the directories, links, files, and documents that exist on accessible projects without scraping the web UI. R26 closes that with a single read command:

- `freelo files list` — paginated list of every doc / file / link / directory the caller can see, with optional filters by project and by item type.

Subsequent slices (R27 — `files download`) will use the UUIDs surfaced here.

## 2. API surface

### 2.1 `GET /all-docs-and-files` (the only documented list endpoint)

OpenAPI `docs/api/freelo-api.yaml:3909-3954`.

- **Path:** `/all-docs-and-files`
- **Query params (all optional):**
  - `projects_ids[]: integer[]` — filter to items whose project is in this set. Without it, spans every project the caller can see (yaml :3922-3923).
  - `type: string`, enum `[directory, link, file, document]` — narrow to a single category. yaml :3932-3936 documents this as a string, not an array (i.e. only one `type` filter at a time).
  - `p: integer` — 0-indexed page. `PageParam` shared (yaml :4766-4773).
- **Response shape:** `PaginatedResponse` wrapper (`{ total, count, page, per_page, data: { items: FileItem[] } }`). yaml :3944-3954. Inner key is **`items`** (different from R21's `reports` and R16's `comments` — fixturing must use the right key).
- **Item shape:** `FileItem` (yaml :5973-6026) — `uuid`, `name`, `author`, `project`, `directory_uuid?`, `date_add`, `order`, `type`, plus type-specific nullable fields (`filename`, `caption`, `mime_type`, `extension`, `size`, `color`, `items_count`, `link`, `link_type`, `note`).

### 2.2 What we explicitly do **not** call

- **Task-scoped file listing.** The roadmap line names a `--task <id>` flag, but `/all-docs-and-files` does **not** accept a `task_id` / `tasks_ids[]` parameter (only `projects_ids[]`, `type`, `p` per yaml :3925-3937). No alternative task-scoped doc/file listing endpoint exists in `docs/api/freelo-api.yaml` — `/file/{file_uuid}` (yaml :3835-3865) is a download-by-UUID, not a listing. The orchestrator's hard rule is "never guess API behavior" (Calibration §1; autonomous-sdlc §"API behavior not in `docs/api/freelo-api.yaml`").
  - **Decision 01 (logged):** Defer `--task <id>` from R26 v1. The roadmap requirement is met for the three filters the API actually supports (`--project`, `--type`, paging). When Freelo extends the endpoint, R26.5 adds the flag (additive, non-breaking). Precedent: R23 (`labels list`) deferred `--project` because the API didn't expose attachments — same shape of decision (`docs/decisions/2026-04-23-2200-r23-labels-1-defer-project.md`).
- **Bulk task→files lookup via per-task fetch.** Some clients work around the gap by walking comments / descriptions to harvest `<a data-freelo-uuid>` anchors. That's both fragile (server-side render mode varies) and out of scope for a thin list wrapper.

## 3. CLI surface

### 3.1 New leaf command under existing `files` namespace

```
freelo files list [--project <id>...] [--type doc|file|link|dir] [--page N | --all]
```

R25 already registered the `files` namespace via `src/commands/files.ts` (it currently delegates only to `registerUpload`). R26 adds a sibling factory `registerList` and wires it in alongside the existing `registerUpload(files, getConfig, env)` call.

### 3.2 Flag reference

| Flag | Type / values | Default | Notes |
|---|---|---|---|
| `--project <id>` | positive int (repeatable) | — | Maps to wire `projects_ids[]`. Repeat for OR. Single `--project <id>` is the most common case but the wire field is array-shaped, and aligning early avoids a breaking change later. Same convention as R21 / R16. |
| `--type <kind>` | one of `doc`, `file`, `link`, `dir` (CLI form) | — | Maps to wire `type` enum (`document` / `file` / `link` / `directory`). CLI form is the **shortened** roadmap label (`doc` / `file` / `link` / `dir`); a small mapping in the leaf converts to the wire form (decision 02). The wire enum accepts only one value at a time per OpenAPI; `--type` is **not** repeatable. |
| `--page <n>` | 1-indexed positive int | (omitted) | Single-page mode. **Mutex** with `--all`. CLI uses **1-indexed** for human ergonomics (mirrors R21 `reports list --page` / R16 `comments list --page`). Subtracted by 1 to map to wire 0-indexed `p=`. |
| `--all` | boolean | false | Iterate `?p=0,1,…` until exhausted. **Mutex** with `--page`. |

`--output`, `--color`, `--profile`, `-v`, `--request-id` are inherited globals.

#### 3.2.1 Why `--project` is repeatable

The wire field is `projects_ids[]: integer[]`. Repeating for OR-across-ids matches the documented server behavior and matches R21 / R16 precedent. The roadmap line shows `--project <id>` (singular) — that's a writing convention; the runtime supports `--project 11 --project 22`.

#### 3.2.2 `--type` short forms vs. wire enum

**Decision 02 (logged):** CLI surface uses the four short labels named in the roadmap (`doc`, `file`, `link`, `dir`). The wire enum values are `document`, `file`, `link`, `directory`. The leaf maps:

| CLI value | Wire value |
|---|---|
| `doc` | `document` |
| `file` | `file` |
| `link` | `link` |
| `dir` | `directory` |

Rationale: the roadmap line is the contract for CLI ergonomics; mapping is one switch statement; reviewers can grep for both forms easily; agents can introspect via `--introspect` to discover the choices.

The validator throws `ValidationError` (exit 2) on any other value, listing the four valid CLI choices in `hintNext`.

#### 3.2.3 `--page` indexing convention

**Same as R21 / R16 / R03:** `--page` is **1-indexed** in the CLI (`--page 1` = first page). The **wire** stays 0-indexed; the **envelope `paging.page`** echoes the wire value (0-indexed) so agents resume from the cursor the server returned.

### 3.3 Output schema: `freelo.files.list/v1`

Envelope `data`:

```jsonc
{
  "applied_filters": {
    "projects": [11, 22],          // present only when --project given
    "type": "document"             // wire form, present only when --type given
  },
  "items": [FileItem, ...]         // see §4.1
}
```

Envelope-level fields:

- `paging`: present on every response.
  - **`--page N`** (1-indexed CLI → 0-indexed wire): `paging` reflects the wire response.
  - **`--all`**: synthesized — `page: 0, per_page: <merged-length>, total: <observed-server-total>, next_cursor: null` (mirrors R21 / R16 / R03 via `pagingFromNormalized` on the merged page).
  - **Default** (no `--page`, no `--all`): `paging` reflects the wire response for `p=0`.
- `rate_limit`: from the last GET (last fetched page when `--all`).
- `notice`: present on `--all` partial-pages failure (mirrors R03 / R16 / R21).

**Decision 03 (logged):** `applied_filters.type` carries the **wire form** (`document` / `file` / `link` / `directory`), not the CLI short form. Agents pinning the CLI version round-trip the same string they'd send when calling Freelo directly via REST. The CLI-side validator records that the user passed `doc`, but the envelope's purpose is server-shape alignment.

### 3.4 Human renderer

`cli-table3` with columns: `UUID`, `TYPE`, `NAME`, `PROJECT`, `AUTHOR`, `DATE`, `SIZE`. Empty list → `(no docs or files)` line. Truncating column index = 2 (`NAME`).

- `UUID` — `FileItem.uuid` slice (first 8 chars + `…`) for human compactness; full UUIDs in JSON. Mirrors the R25 upload-success line which prints first-8 + `…`.
- `TYPE` — `FileItem.type` (wire enum: `directory` / `link` / `file` / `document`).
- `NAME` — `FileItem.name`, truncated to 60 chars; fallback `-` when null/empty.
- `PROJECT` — `project.name` or `-`. Same pattern as `formatRefName` in `reports-list`.
- `AUTHOR` — `author.fullname` or numeric `id`, `-` otherwise (same as R21's `formatUserCell`).
- `DATE` — `date_add` slice (`YYYY-MM-DD`).
- `SIZE` — humanized byte count (e.g. `1.4 MB`) for `file` / `document` types; `-` for `directory` / `link`.

`humanizeBytes(n)` is a one-line helper colocated in the renderer (avoids a new `lib/` file for a six-row switch). Pattern: `n < 1024 → '<n> B'`, `<1 MB → '<n> KB'`, `<1 GB → '<n> MB'`, otherwise `'<n> GB'`, all rounded to 1 decimal. Already-tested precedent: nothing close enough exists; this is small and renderer-local.

## 4. Data model

### 4.1 New wire schema — `FileItem`

New schemas appended to `src/api/schemas/file.ts` (the file already exists from R25 with `FileUploadResponseSchema` etc. — R26 extends, doesn't replace). Loose-by-design (passthrough, nullable+optional on every non-id field), mirroring `WorkReportFullSchema` in `report.ts`.

```ts
const UserBasicSchema = z.object({
  id: z.number().int(),
  fullname: z.string().nullable().optional(),
}).passthrough();
// Local copy rather than import from schemas/project.ts — that one is NOT
// passthrough; the FileItem author can carry avatar/email/role on some
// endpoints. Stay loose. Same divergence rationale as report.ts.

const ProjectRefSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable().optional(),
}).passthrough();

export const FileItemTypeSchema = z.enum(['directory', 'link', 'file', 'document']);
export type FileItemType = z.infer<typeof FileItemTypeSchema>;

export const FileItemSchema = z.object({
  uuid: z.string().min(1),
  name: z.string().nullable().optional(),
  author: UserBasicSchema.nullable().optional(),
  project: ProjectRefSchema.nullable().optional(),
  directory_uuid: z.string().nullable().optional(),
  date_add: z.string().nullable().optional(),       // ISO date-time
  order: z.number().int().nullable().optional(),
  type: FileItemTypeSchema,
  filename: z.string().nullable().optional(),
  caption: z.string().nullable().optional(),
  mime_type: z.string().nullable().optional(),
  extension: z.string().nullable().optional(),
  size: z.number().int().nullable().optional(),
  color: z.string().nullable().optional(),
  items_count: z.number().int().nullable().optional(),
  link: z.string().nullable().optional(),           // url
  link_type: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
}).passthrough();
export type FileItem = z.infer<typeof FileItemSchema>;

export const FilesListAppliedFiltersSchema = z.object({
  projects: z.array(z.number().int()).optional(),
  type: FileItemTypeSchema.optional(),  // wire form (decision 03)
});
export type FilesListAppliedFilters = z.infer<typeof FilesListAppliedFiltersSchema>;

export const FilesListDataSchema = z.object({
  applied_filters: FilesListAppliedFiltersSchema,
  items: z.array(FileItemSchema),
});
export type FilesListData = z.infer<typeof FilesListDataSchema>;
```

**Loose schema rationale:** Per `conventions.md` "Optional response fields are also nullable" rule. Default to passthrough + nullable.optional on every block; agents can downcast in their own consumers.

**`type` is required-non-null in the schema** because the OpenAPI lists it without `nullable: true` and the renderer needs it to format the size column. If a future server response omits `type`, that's a contract break — `FreeloApiError VALIDATION_ERROR` is correct (matches the R21 pattern where `id` and `date_reported` are likewise non-null).

### 4.2 Wire wrapper — `getAllDocsAndFiles`

Appended to existing `src/api/files.ts` (already houses `uploadFile` from R25). Mirrors `getWorkReports` byte-for-byte modulo names, schema, and the simpler param set.

```ts
/** Path constant — exposed so callers can build `would` / log paths. */
export const ALL_DOCS_AND_FILES_PATH = '/all-docs-and-files';

export type AllDocsAndFilesFilters = {
  projects?: readonly number[];
  type?: FileItemType;  // wire enum
};

export type AllDocsAndFilesOpts = FetchOpts & {
  /** 0-indexed page; mapped to `?p=N` on the wire. */
  page: number;
  filters: AllDocsAndFilesFilters;
};

export type FilesListResult = {
  page: NormalizedPage<FileItem>;
  raw: ApiResponse<unknown>;
};

export async function getAllDocsAndFiles(
  client: HttpClient,
  opts: AllDocsAndFilesOpts,
): Promise<FilesListResult> {
  const { filters } = opts;
  const params: Record<string, string | number | boolean | readonly (string | number)[] | undefined> = {
    p: opts.page,
  };
  if (filters.projects !== undefined && filters.projects.length > 0) {
    params['projects_ids[]'] = filters.projects;
  }
  if (filters.type !== undefined) {
    params['type'] = filters.type;
  }
  const qs = buildQuery(params);
  const path = qs.length > 0 ? `${ALL_DOCS_AND_FILES_PATH}?${qs}` : ALL_DOCS_AND_FILES_PATH;
  const raw = await client.request({
    method: 'GET',
    path,
    schema: z.unknown(),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = normalizePaginated(raw.data, 'items', FileItemSchema);
  return { page, raw };
}
```

`buildQuery` already emits the bracketed-array convention Freelo expects (`projects_ids%5B%5D=11`); `tests/lib/query.test.ts` covers it.

## 5. Edge cases

1. **Empty result** — `total: 0`, `data.items: []`. Envelope still emits `applied_filters` + `paging` + `rate_limit`; renderer prints `(no docs or files)`.
2. **`--page N` past the end** — server returns `count: 0, data: { items: [] }`. Envelope's `paging.next_cursor: null`; exit 0. (Same convention as R21.)
3. **Mutex `--page` / `--all`** — `ValidationError` (exit 2) at parse time, before any network call.
4. **Invalid `--project`** — `ValidationError` (exit 2) for non-positive-int values.
5. **Invalid `--type`** — `ValidationError` (exit 2) for any value not in `{doc, file, link, dir}`. Hint lists the four valid CLI choices.
6. **Auth / API failures** — `FreeloApiError` propagates with the right `httpStatus`. 401 → exit 4 with `code: 'AUTH_REQUIRED'` per the existing handler. 403 / 404 / 5xx → exit 4. 429 → `RateLimitedError` (exit 6) after retry exhaustion. Network → `NetworkError` (exit 5).
7. **`--all` mid-stream failure** — `PartialPagesError` unwrap path emits a partial envelope to stdout with `notice: "Partial result; iteration aborted at page <N>."` then re-throws for the right exit code. Same rate-limit and request-id metadata as the last successful page. Mirrors R21 / R16.
8. **Response schema mismatch** — `FreeloApiError` with `code: 'VALIDATION_ERROR'` (exit 4). Per `normalizePaginated`, the wrapper schema fails fast with the zod error message.
9. **`author.fullname` absent** — passthrough + nullable.optional on `UserBasicSchema`. Renderer falls back to `String(author.id)`.
10. **`size` null on a `directory` row** — renderer's column logic returns `-` whenever size is null/undefined or when type is `directory` / `link`. (Matches the OpenAPI shape: only `file` / `document` rows reliably carry a byte size.)
11. **`type` of `link` with a null `link` field** — the renderer doesn't crash; only the size column reads from `size`. Schema permits it (passthrough + nullable.optional).

## 6. Non-goals (deferred to later slices)

- **`--task <id>` filter** — endpoint doesn't support it (decision 01). Tracked as potential R26.5 if Freelo adds task-scoped listing.
- **`--mime <type>` / `--extension <ext>` / `--name <pattern>`** — not in the OpenAPI as server-side filters. A future client-side `--filter` (post-fetch) could surface these but adds non-trivial UX (when to short-circuit `--all`?). Out of scope for v1.
- **`--directory <uuid>` filter** — `directory_uuid` is on the response shape but not the OpenAPI param list; not in v1.
- **`--fields` projection** — neither R21 nor R16 surface it; staying parity. Easy to add later.
- **Multi-value `--type` (`--type doc --type file`)** — wire enum is single-valued per OpenAPI. If the server adds support, expand later (additive change).

## 7. Open questions

None at draft time. Decisions 01-03 are logged below without ambiguity. No human gate needed before plan.

## 8. Test plan (informs Phase 4 — test-writer)

Test file: `test/commands/files/list.test.ts`. Pattern: `test/commands/reports/list.test.ts`.

**Happy paths:**
- Default invocation (no flags) → `?p=0`, `applied_filters: {}`, exit 0.
- `--page 1` → wire `p=0`; envelope `paging.page === 0`.
- `--page 3` → wire `p=2`; envelope `paging.page === 2`.
- `--all` across 2 pages — merged item list, `paging.next_cursor === null`.
- `--project 11 --project 22` → wire `projects_ids[]=11&projects_ids[]=22`; `applied_filters.projects === [11, 22]`.
- `--type doc` → wire `type=document`; `applied_filters.type === 'document'`.
- `--type file` → wire `type=file`.
- `--type link` → wire `type=link`.
- `--type dir` → wire `type=directory`.
- All filters combined.
- Empty list — `(no docs or files)` in human mode (TTY simulated).
- `--request-id` round-trip (sent header + echoed in envelope).
- Introspect entry shows `output_schema: 'freelo.files.list/v1'`, `destructive: false`.
- Human-mode rendering on TTY (asserts table is emitted to stdout, contains UUID prefix and TYPE column).

**Validation paths (every typed error has an exit-code assertion — Calibration §2):**
- `--page` and `--all` together → `ValidationError`, exit 2.
- `--page abc` (non-int) → `ValidationError`, exit 2.
- `--page 0` (zero) → `ValidationError`, exit 2.
- `--project xyz` → `ValidationError`, exit 2.
- `--project 0` → `ValidationError`, exit 2.
- `--type bogus` → `ValidationError`, exit 2 (hint lists `doc, file, link, dir`).
- `--type document` (wire form, not CLI form) → `ValidationError`, exit 2 — explicit guard: we accept the four CLI short forms only. Decision 02.

**HTTP error paths:**
- 401 → `FreeloApiError`, exit 4 with `AUTH_REQUIRED`.
- 403 → `FreeloApiError`, exit 4.
- 404 → `FreeloApiError`, exit 4.
- 5xx → `FreeloApiError`, exit 4.
- 429 with `Retry-After: 0` after retry exhaustion → `RateLimitedError`, exit 6.
- Network drop → `NetworkError`, exit 5.
- `--all` mid-stream 5xx after 1 success → partial envelope with `notice`, exit 4.

**Schema-validation path:**
- Server returns `data: { items: [{ uuid: 'a', type: 'unknown_kind' }] }` → `FreeloApiError` with `code: 'VALIDATION_ERROR'` (exit 4).

Coverage targets: same as `src/commands/reports/`/`src/api/reports.ts` — 90%+ on `src/commands/files/list.ts` and on the `getAllDocsAndFiles` half of `src/api/files.ts`.

## 9. Examples (agent-style)

```bash
# Default — first page, no filters
FREELO_API_KEY=$KEY FREELO_EMAIL=$EMAIL freelo files list --output json

# Filter to one project, only documents
FREELO_API_KEY=$KEY FREELO_EMAIL=$EMAIL freelo files list \
  --project 235826 --type doc --output json

# All files across two projects, paginated client-side
FREELO_API_KEY=$KEY FREELO_EMAIL=$EMAIL freelo files list \
  --project 11 --project 22 --type file --all --output json
```

## 10. Wire-up checklist (informs Phase 6 — doc-writer)

- New page: `docs/commands/files-list.md` (mirror `docs/commands/files-upload.md` for layout + `docs/commands/reports-list.md` for paging-flag prose).
- README autogen block refresh — `pnpm fix:readme` after the new command is registered.
- No update to `docs/getting-started.md` in this slice (R25 was already the "first-time-user" files slice).
- Update `src/commands/files.ts` description to reflect that `list` joined `upload`.

---

## Plan

File-level intent. Each row is one commit-sized change. **No new runtime dependencies.**

### New files

- **`src/api/schemas/file.ts`** — APPEND `UserBasicSchema` (local), `ProjectRefSchema`, `FileItemTypeSchema`, `FileItemSchema`, `FilesListAppliedFiltersSchema`, `FilesListDataSchema` to the existing R25 file. Existing `FileUploadResponseSchema` / `FilesUploadDataSchema` / `WouldEntrySchema` etc. are untouched.
- **`src/api/files.ts`** — APPEND `ALL_DOCS_AND_FILES_PATH`, `AllDocsAndFilesFilters`, `AllDocsAndFilesOpts`, `FilesListResult`, `getAllDocsAndFiles()` to the existing R25 file. Existing `FILE_UPLOAD_PATH` / `uploadFile` are untouched.
- **`src/ui/human/files-list.ts`** — `cli-table3` renderer. Columns: UUID (first-8 + `…`), TYPE, NAME, PROJECT, AUTHOR, DATE, SIZE. Empty fallback `(no docs or files)`. `humanizeBytes` helper colocated. Pattern: `src/ui/human/reports-list.ts`.
- **`src/commands/files/list.ts`** — leaf command. Parses `--project` (repeatable), `--type` (CLI→wire mapping), `--page` / `--all` (mutex), dispatches to `getAllDocsAndFiles`, builds envelope. Pattern: `src/commands/reports/list.ts`. Schema string `freelo.files.list/v1`. `meta` exported with `destructive: false`.
- **`test/commands/files/list.test.ts`** — vitest + MSW. Covers every test bullet in §8. Pattern: `test/commands/reports/list.test.ts`.
- **`docs/commands/files-list.md`** — user-facing doc page. Pattern: `docs/commands/reports-list.md` for flag prose, `docs/commands/files-upload.md` for namespace context.
- **`.changeset/r26-files-list.md`** — `freelo-cli: minor`; new command + new envelope schema callout (`schema 'freelo.files.list/v1' added`) per the schema-stability rule in `conventions.md`.

### Modified files

- **`src/commands/files.ts`** — register `registerList` alongside `registerUpload`. Two-line edit: import + call. Description updated to "Upload, list, and download project files. v1: upload + list (R25, R26)."
- **`test/msw/handlers.ts`** — add `allDocsAndFilesListHandlers` with `paged`, `unauthorized`, `forbidden`, `notFound`, `serverError`, `rateLimited`, `networkError`, `midStreamError`, `malformed`. Pattern: `workReportsListHandlers`. URL: `${API_BASE}/all-docs-and-files`. Inner key: `items`.
- **`README.md`** — refresh autogen `<!-- BEGIN AUTOGEN COMMANDS -->` block via `pnpm fix:readme` after the command lands.

### No-touch

- `src/bin/freelo.ts` — already imports and calls `registerFiles`; no change. The new leaf is registered inside `commands/files.ts`.
- `src/api/client.ts` — unchanged. The HTTP client takes a `path` string; bracket encoding lives in `buildQuery`.
- `src/api/pagination.ts` — `normalizePaginated` and `fetchAllPages` already handle the `{ data: { items: [...] } }` shape via the `innerKey` parameter.
- `src/lib/query.ts` — already emits `key[]=value` repeating-array form.
- `src/errors/*` — no new error classes; reuse `ValidationError`, `FreeloApiError`, `RateLimitedError`, `NetworkError`.
- `src/ui/envelope.ts` — no new envelope-level fields; `freelo.files.list/v1` is just a new schema string.

### Test strategy

- Unit-ish leaf tests via `runCli` helper (mirrors `reports/list.test.ts`).
- All HTTP exercised through MSW; no live network.
- Every typed error path has an `expect(exitCode).toBe(N)` assertion (Calibration §2).
- One TTY-mode test asserting human renderer output (with `delete process.env['CI']` per Calibration §7 if/when prompts are involved — this command has no prompts so the basic isTTY override is sufficient; Calibration §7 strictly applies to prompt-gated paths).
- For `--type` wire-mapping coverage, one test per wire value (4 tests) so the switch's branch coverage hits every arm.

### Rollout order

Single landable slice — no need for sub-slicing. Order of edits inside the commit:

1. Schemas first (extend `schemas/file.ts`).
2. Wire wrapper (extend `api/files.ts`).
3. Human renderer (`ui/human/files-list.ts`).
4. Leaf command (`commands/files/list.ts`).
5. Namespace registration (extend `commands/files.ts`).
6. MSW handlers (extend `test/msw/handlers.ts`).
7. Tests.
8. Run local gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
9. Run `pnpm fix:readme` to regenerate the README autogen block.
10. Doc page.
11. Changeset.
12. `pnpm check:readme` to confirm autogen matches.

### Risks / known gotchas

- **`--task` deferral discoverability.** Agents that read the roadmap will look for `--task` and won't find it. Mitigation: the leaf's `--help` description, the doc page, and the changeset all explicitly state "no task filter; deferred — endpoint does not surface one in `docs/api/freelo-api.yaml`". Decision 01 logged.
- **CLI vs wire `type` form.** Tests must assert the wire query carries `type=document` (wire) when CLI uses `doc`. Easy to write a test that accidentally only checks `'document' in query` — the negative-test (`--type document` rejected by CLI) catches this.
- **Inner-key drift.** `/all-docs-and-files` uses `items` (not `reports`, not `comments`, not `tasks`). Off-by-one mistake on the `normalizePaginated` call would surface as a schema validation error in tests; the malformed-fixture test uses inner key `items` to confirm the wrapper expects the right shape.
- **`UserBasicSchema` divergence (third copy).** `report.ts` already has a passthrough copy diverging from the strict copy in `project.ts`. R26 adds a third local copy in `file.ts`. A future "hoist to a shared loose UserBasicSchema" refactor is tracked but out of scope here — the cost of the duplication (≈4 lines) is lower than coupling four schemas to a shared definition.
- **Renderer humanizeBytes** is small but new. Two tests (B/KB, MB/GB boundaries) keep it honest.

### Decision log entries to be created during implement

(Decisions 01-03 are pre-logged below before implement starts. If the implementer hits an unexpected schema-shape surprise during MSW fixturing, log Decision 04 there.)
