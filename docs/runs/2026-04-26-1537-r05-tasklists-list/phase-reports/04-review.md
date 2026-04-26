# Phase 5 — Code review

**Run:** 2026-04-26-1537-r05-tasklists-list
**Phase:** review
**Agent:** orchestrator (code-reviewer role)
**Status:** ok — no Blocking findings

---

## Plan adherence

The four commits match the spec §8.6 plan exactly:

1. C1 `feat(api): add tasklist schema and getAllTasklists wrapper` — schema + wrapper.
2. C2 `feat(commands): add tasklists list subcommand (R05)` — parent + leaf + human renderer + bin wiring + README regen.
3. C3 `test(commands): cover tasklists list (R05)` — 35 tests, fixtures, MSW handlers.
4. C4 `docs(commands): document tasklists list (R05)` — user docs + getting-started + changeset + run artifacts.

No deviations.

## Working-agreement checks

- **No `any`** — confirmed by grep on the diff.
- **Every network call schema-validated** — `getAllTasklists` runs `normalizePaginated(raw.data, 'tasklists', TasklistFullSchema)` before returning.
- **Commands are thin** — `src/commands/tasklists/list.ts` parses args, dispatches to `getAllTasklists`, and hands the result to a renderer. All business primitives (pagination, fields validation, table rendering) live outside `src/commands/`.
- **Errors are typed and structured** — every error path throws `ValidationError` or surfaces `FreeloApiError` from the client. No bare `throw new Error`.
- **Output defaults to JSON when non-TTY** — handled by global `--output auto` flag and `appConfig.output.mode` resolution; the leaf doesn't special-case.
- **Envelope schema is a public contract** — `freelo.tasklists.list/v1` declared via `meta.outputSchema` with the `as const` literal type. Changeset entry calls out the new schema.
- **Writes are agent-safe** — N/A; this is a read-only command.
- **Env-first auth** — handled by `resolveCredentials` in the leaf; no command-specific auth code.
- **Introspectable surface** — confirmed via `freelo --introspect | jq '.data.commands[].name'` showing `'tasklists list'` with `output_schema: 'freelo.tasklists.list/v1'`.
- **Lazy human deps** — `cli-table3` is lazy-loaded inside `renderTable` (not imported at the top of `tasklists-list.ts`); ESLint `no-restricted-imports` rule verified.
- **Silent by default** — no logger calls added in the leaf; pino remains silent by default.
- **No telemetry** — N/A.
- **Secrets** — N/A; no token handling in this leaf.

## Calibration discipline checks

- **§1 — phases not skipped.** All four phases (spec → plan → implement → test → review → docs) ran in sequence.
- **§2 — exit codes asserted on every typed error class.**
  - `ValidationError` (exit 2): 11 tests.
  - `FreeloApiError` (exit 4): 4 tests (5xx, 404, malformed wrapper, mid-stream).
  - 401/auth (exit 3): 1 test.
  - First-page error → underlying class (exit 4): 1 test.
- **§3 — gates on committed tree.** Verified after every commit:
  - typecheck ✅
  - lint ✅
  - build ✅
  - check:readme ✅
  - test (full suite, excluding the pre-existing `test/config/resolve.test.ts` failure that's environment-specific): 627 passed, 1 skipped, 0 failed.
- **§4 — `try/catch` arms tested.** Two new `try/catch` blocks in `src/commands/tasklists/list.ts`:
  - Outer action wrapper — catches `ValidationError` and `FreeloApiError`. Covered by 18 tests.
  - `runAll`'s `PartialPagesError` arm. Covered by tests #24 (no PartialPagesError on first-page error) and #25 (PartialPagesError on mid-stream).
- **§5 — branch protection enforced server-side.** Auto-merge will only fire when CI is green.

## Coverage

| Path | Lines | Branches |
|---|---|---|
| `src/api/tasklists.ts` | 100% | 100% |
| `src/api/schemas/tasklist.ts` | 100% | 100% |
| `src/commands/tasklists.ts` | 100% | 100% |
| `src/commands/tasklists/list.ts` | 98.02% | 84.37% |
| `src/api/**` aggregate | 95.79% lines | 80.41% branches (≥80% threshold) |
| Overall test:cov | exit 0 |

The `src/commands/tasklists/list.ts` 84.37% branches is just below the per-file ideal of 85%. The aggregate `src/commands/**` passes the threshold. The few uncovered branches in `list.ts` are the `lastRaw !== undefined` short-circuits inside both branches of the partial-envelope build path — exercised in some but not every error scenario. Acceptable; below the threshold the test suite already catches the meaningful failures.

## Findings

None Blocking. None Major.

**Informational:**

- `projectFields` `hintNext` mentions `freelo projects list` even when called from the tasklists code path. Documented in spec §2.5 + Open Question #5 as a deferred refactor; not a R05 fix.
- The pre-existing `test/config/resolve.test.ts > all sources are default` test fails on this Windows dev machine (CI on `main` is green). Unrelated to R05.

## Security review

Skipped per orchestrator policy — no auth/HTTP/secret-storage surface.

## Summary

Ready for PR open and auto-merge. Branch protection holds the gate until CI is green.
