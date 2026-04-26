# Phase report — Implement (combined)

Bug A and Bug B implemented in two commits on `fix/projects-list-null-and-libuv`.

## Commit 1 — `fix(api): tolerate null in optional response fields`

`src/api/schemas/project.ts`:
- `ClientSchema`: every string field `.nullable().optional()`.
- `ProjectWithTasklistsSchema`: `date_add`, `date_edited_at`, `tasklists`,
  `client` all `.nullable().optional()`.
- `ProjectFullSchema`: same sweep on every previously-`.optional()` field
  (`owner`, `state`, `budget`, `real_cost`, `real_minutes_spent`, both
  date fields).
- `minutes_budget` was already correct.

Verified the existing human renderer (`src/ui/human/projects-list.ts`)
already short-circuits on `value === null`, so no UI change needed.

`.claude/docs/conventions.md`: one-line policy added under "API client".

Tests: 7 new cases across `test/api/schemas/project.test.ts` covering each
relaxed field; one new MSW-driven case in `test/api/projects.test.ts`
exercising the full `getOwnedProjects` parse path with the new fixture.

## Commit 2 — `fix(errors): drain undici dispatcher before exit`

`src/errors/handle.ts`:
- `handleTopLevelError` now `async (err, mode): Promise<never>`.
- New `drainDispatcher()` helper: `await getGlobalDispatcher().close()`
  inside try/catch so the original exit code survives.
- Drain called on the SIGINT/AbortError branch and the typed-error branch.

`src/bin/freelo.ts`:
- `await` the new async signature at the two callsites (`preAction` hook
  and the outer `run` try/catch).
- SIGINT handler drains then exits 130 (fire-and-forget so Ctrl-C stays
  responsive).
- Bootstrap `.catch` drains then exits 1.

10 command files (`src/commands/{auth,config,projects,help}/*.ts`):
- `await handleTopLevelError(err, mode);` in every catch.
- 5 actions converted from sync to async to satisfy `await`.

Tests: existing 21 handle tests updated from `expect(() => fn()).toThrow()`
to `await expect(fn()).rejects.toThrow()`. Three new cases in a new
`describe('drains undici dispatcher before exit (libuv fix)')` group:
- typed-error path: close ordered before exit
- SIGINT/AbortError path: close ordered before exit 130
- close() rejection: original exit code preserved

undici namespace mocked via `vi.mock('undici', ...)` because direct
`vi.spyOn` on a re-exported function fails on the read-only namespace.

## Verification

```
pnpm typecheck && pnpm lint && pnpm build && pnpm check:readme   PASS
pnpm test test/api/schemas/project.test.ts \
         test/api/projects.test.ts \
         test/errors/handle.test.ts                              55/55
```

Full-suite delta: +3 passing tests (608 vs 605 baseline). Pre-existing
`resolve.test.ts` flake unchanged.
