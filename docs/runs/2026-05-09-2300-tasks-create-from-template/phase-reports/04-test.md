# Phase 4 — Test

**Files created:**

- `test/api/tasks-create-from-template.test.ts` — 14 unit tests on `buildCreateTaskFromTemplateBody`, `createTaskFromTemplatePath`, `createTaskFromTemplate`. **Mandatory per calibration §4** (R38 PR #96 finding): exercises both `signal`-defined and `requestId`-defined opt-spread branches AND the omit branches in the new wrapper.
- `test/commands/tasks/create-from-template.test.ts` — 28 integration tests across happy paths (4), dry-run (3), validation errors (9), API errors (11), introspect (1).
- `test/fixtures/tasks/create-from-template-9100.json` — sample 200 response.

**Files modified:**

- `test/msw/handlers.ts` — added `tasksCreateFromTemplateHandlers` (10-handler set: `ok`, `okWhenBody`, `badRequest`, `unauthorized`, `forbidden`, `notFound`, `unprocessable`, `rateLimited`, `serverError`, `networkError`).

**Test results:**

- New file targeted run: 42 / 42 pass.
- Full project run (excluding pre-existing failure): 2445 / 2445 pass, 1 skipped.
- Coverage thresholds: all met (no `ERROR: Coverage for...threshold` lines emitted).

**Pre-existing failure (not caused by R39):**

- `test/config/resolve.test.ts:278` — `buildSourceMap` returns `'conf'` instead of `'default'` because `safeReadStore()` reads the developer's actual `conf` store (no MSW mock applied in that unit test). Verified by `git stash` test on the parent commit — same failure on clean `main`. Out of scope for R39.

**Calibration coverage:**

- §1 — full test phase ran before commit (all 5 gates).
- §2 — every error-class path explicitly asserts `exitCode` (`ValidationError` 2, `FreeloApiError` 4, `AUTH_EXPIRED` 3, `RateLimitedError` 6, `NetworkError` 5).
- §3 — five-gate (`typecheck && lint && test && build && check:readme`) on the working tree; will re-run on the committed tree before push.
- §4 — `test/api/tasks-create-from-template.test.ts` covers `signal` + `requestId` opt-spread branches in `src/api/tasks-create-from-template.ts`. R38 PR #96's regression cannot recur here.
- §7 — not applicable (no TTY-prompt path; `tasks create-from-template` is non-destructive).

**Retries:** 0.

**No pause triggered.**
