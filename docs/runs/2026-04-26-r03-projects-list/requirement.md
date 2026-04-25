# Requirement — R03 `freelo projects list`

**Run:** `2026-04-26-r03-projects-list`
**Resumption point:** Phase 2 (Plan). Phase 1 spec already accepted at `docs/specs/0009-projects-list.md`.

## Summary

Implement `freelo projects list` — first command that talks to the Freelo API.
Introduces:

- `src/api/pagination.ts` — uniform page abstraction over five endpoint shapes.
- `src/ui/table.ts` (lazy `cli-table3`) for human mode.
- `freelo.projects.list/v1` envelope with `entity_shape` discriminator.
- `--page N` / `--all` / `--cursor <n>` / `--fields a,b,c` flags.
- `ProjectListSchema` and entity zod schemas in `src/api/schemas/project.ts`.

## Inputs

- Spec: `docs/specs/0009-projects-list.md` — Status: Accepted, all 17 §7 OQs resolved per architect recommendations. Do not relitigate.
- Tier: **Yellow** (per spec §0; new command + new pagination + new table renderer + first endpoint contact; no auth/HTTP-defaults touch; no new package.json deps).

## Budget

Default: 30m, 40 calls, 8 retries, 25 files.

## Flags

- `--allow-network`: false (MSW only)
- `--ship`: false (PR open is end-state)
