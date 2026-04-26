# Requirement — R05.5 Hardening

**Run:** `2026-04-26-1848-r05-5-hardening`
**Source:** `docs/roadmap.md` §R05.5 (refreshed three times during prior session as new live-API reproducers landed).

Three bugs surfaced by real-world tests against a live Freelo account on
2026-04-26 (against `freelo-cli@0.7.0` and `0.8.0`):

1. **`UserBasic.fullname` declared `z.string()` but Freelo can return user
   objects without it.** Schema is stricter than the wire shape. Sweep all
   response-entity schemas under `src/api/schemas/` and make
   currently-`.optional()` complex fields ALSO `.nullable().optional()`,
   matching the policy already documented in `.claude/docs/conventions.md`
   and decision log entry 1 (spec 0010, 0.5.1 patch).

2. **`CurrencySchema.amount` declared `z.string()` but live API returns a
   number.** Universal — affects `ProjectFull.real_cost`, `ProjectFull.budget`,
   `Tasklist.budget`, `Tasklist.real_cost`. Fix at the schema level
   (`CurrencySchema`), not at each consumer. Accept
   `z.union([z.string(), z.number()])` and **normalize to string** so the
   public envelope contract (`freelo.projects.list/v1`,
   `freelo.projects.show/v1`, `freelo.tasklists.list/v1`) stays stable.

3. **Windows libuv `UV_HANDLE_CLOSING` assertion fires on `process.exit`
   despite the 0.5.1 `drainDispatcher` fix.** Reproduces on **any
   zod-validation failure** on Windows (in `projects show`,
   `projects list --scope all`, and `tasklists list`). The `.close()`
   on undici's global dispatcher is not always sufficient on Windows. The
   regression test must trigger a deliberate zod failure via a subprocess
   on the Windows matrix row and assert that stderr is free of
   `UV_HANDLE_CLOSING` and `Assertion failed:`.

## Constraints

- All three bugs in one patch release `0.8.1`.
- No new commands, no new envelope schemas, no new dependencies.
- Roadmap edit (R05.5 entry) carries into the first commit.
- Tier likely **Yellow** (touches `src/errors/handle.ts` cross-cutting and
  the public `CurrencySchema`; loosening string-only to string|number is
  backwards-compatible).
- Budget defaults: 30m / 40 calls / 8 retries / 25 files.
- `--allow-network`: false. `--ship`: false.
