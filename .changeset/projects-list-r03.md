---
'freelo-cli': minor
---

Add `freelo projects list` for paginated project listing across five scopes.

This is the first command that talks to the Freelo API beyond `auth whoami`.
Selectable via `--scope owned|invited|archived|templates|all` (default `owned`),
with `--page N` / `--all` / `--cursor <n>` (mutually exclusive) for pagination
and `--fields a,b,c` for top-level field projection.

Introduces the `freelo.projects.list/v1` envelope. The `data` payload carries
an `entity_shape` discriminator (`with_tasklists` for the four sparser scopes,
`full` for `--scope all`), the resolved `scope`, and the `projects[]` array.
The envelope's `paging` field is always present — the `/projects` endpoint is
synthesized as a single page so agents do not need to special-case scopes.

Adds shared infrastructure used by every future list command: `src/api/pagination.ts`
(`NormalizedPage`, `fetchAllPages`, `projectFields`) and `src/ui/table.ts` (lazy
`cli-table3` renderer for human mode).

Schema commitment: `freelo.projects.list/v1` is a public contract. Field
removal, rename, or retype is breaking.
