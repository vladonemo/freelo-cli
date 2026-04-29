---
'freelo-cli': minor
---

R26 — `freelo files list`. Browse every directory, link, file, and document the caller can see across accessible projects, with optional filters by project and item type. Second leaf under the `files` subcommand (R25 added `upload`).

```
freelo files list [--project <id> ...] [--type doc|file|link|dir]
                  [--page N | --all]
```

**Three filters mapped to the Freelo wire:**

- `--project <id>` — repeatable, OR semantics; maps to `projects_ids[]`.
- `--type <kind>` — CLI short forms (`doc`/`file`/`link`/`dir`) mapped to the wire enum (`document`/`file`/`link`/`directory`). Single-valued per the OpenAPI.
- `--page <n>` (1-indexed CLI → 0-indexed wire) / `--all` (mutex) — same paging convention as R16 / R21.

**One new envelope schema (additive surface):**

- `schema 'freelo.files.list/v1' added` — `{ applied_filters: { projects?, type? }, items: FileItem[] }`. `applied_filters.type` carries the **wire form** so agents round-tripping to Freelo's REST get a string they can pass straight through.

**`--task <id>` deferred** (decision logged at `docs/decisions/2026-04-29-1756-r26-files-list-1-defer-task.md`). The roadmap names the flag, but `GET /all-docs-and-files` does not accept any task-scoped query parameter per `docs/api/freelo-api.yaml:3925-3937` — only `projects_ids[]`, `type`, and `p`. No alternative task-scoped doc/file listing endpoint is documented. Tracked as potential R26.5; same shape of decision as R23 (which deferred `--project` for the same class of reason). The `--help` description, the doc page, and this changeset all name the deferral so agents reading the roadmap don't trip on the absence.

**Out of scope for v1:**

- No `--mime` / `--extension` / `--name` filters (not server-side; client post-filter on `--all` is future-additive).
- No `--directory <uuid>` filter (`directory_uuid` is on the response shape but not in the wire query parameter list).
- No `--per-page` (server-controlled).
- No `--fields` projection (R03 ships the helper but R16 / R21 don't surface it; staying parity).
- No write surface — upload is R25, download will be R27.

No new dependencies. Reuses `commander`, `zod`, `undici` (via the shared HTTP client), `src/api/pagination.ts` (`fetchAllPages`, `pagingFromNormalized`, `PartialPagesError`), `src/lib/query.ts`, `src/ui/envelope.ts`, `src/ui/table.ts`. The `getAllDocsAndFiles` wire wrapper appends to the existing R25 `src/api/files.ts`; `FileItemSchema` and friends append to `src/api/schemas/file.ts`.
