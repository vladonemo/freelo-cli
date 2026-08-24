# Phase 6 — Review

**Status:** complete — **no Blocking findings**
**Security review:** not triggered (`needsSecurityReview: false`; the diff touches no auth, config,
HTTP-client, or credential-handling code)

## Checklist (`.claude/docs/sdlc.md` Phase 5)

| Check | Result |
|---|---|
| Plan adherence | Yes, with two logged deviations: TODO-2/TODO-6 dropped (§8b, decision 4) and TODO-1's `??`-per-half replaced by both-absent gating (decision 4). TODO-3 amended by decision 5. Plan checkboxes updated in the spec — the plan stayed the contract |
| No `any`, no un-validated response | Unchanged. Response still parsed by `z.array(TaskSummarySchema)` |
| No bare `throw new Error` | No new throws at all |
| Agent-first output / envelope | Unchanged. Same `freelo.tasks.list/v1`, same fields, same values — §8b was chosen precisely so no consumer sees a diff |
| Structured errors | No new error path (spec §7) |
| Writes are agent-safe | N/A — read-only command |
| Lazy human deps | No import added anywhere |
| Schema stability | No field removed/renamed/retyped. No `/v2` bump needed. Asserted directly by test `3.` |
| Help text | No flag added, removed, or re-described; `--introspect` output is unchanged |
| Changeset added | Yes, `patch`, and it names the issue honestly (see below) |
| No secrets in fixtures | No fixture added. No account id, response body, or credential appears anywhere in the diff — deliberate, per decision 5 |

## Findings

**Informational 1 — the claim in the changeset is load-bearing.** "Fixes #108" rests entirely on an
out-of-band live check that this repo cannot re-run in CI (spec §12). The evidence is recorded in
three places (spec §12, the OpenAPI `description`, the JSDoc) rather than a fixture, because a
fixture would encode the conclusion into a mock that can only ever agree with it (§5.2). A reviewer
who doubts the finding should re-run the §11 experiment, not read a test.

**Informational 2 — one branch of the fix is untestable by construction.** That the *returned* order
is board order can never be asserted here. What is asserted is that the CLI stops leaving the
question to an unstated server default. Reviewers should read test `3.` as "the request is now
explicit", not "the order is now correct".

**Informational 3 — `/all-tasks` fallthrough (out of scope, needs a human decision later).** The
symptom only reproduces on the exact route `--project` + `--tasklist` + no other filter. Every other
shape silently routes to `/all-tasks` (`resolveRoute()`, `src/commands/tasks/list.ts:165-191`), which
defaults to `date_add` and has no board-order concept. A user who adds `--worker` to the fixed
command still gets creation order, with nothing in the envelope beyond `data.endpoint` to explain
why. This is plausibly the real mechanism behind #108 and is carried into the PR body as a
follow-up. **Not touched here** — the human ruled it out of scope on resume, and changing routing is
a materially larger blast radius than this fix.

## Gates (run on the committed tree, calibration entry #3)

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm build` | pass |
| `pnpm check:readme` | pass |
| `pnpm format:check` | pass for every file this run touched (two files fail on `main` already and are not in CI) |
| `npx vitest run test/commands/tasks/list.test.ts` | **46/46 pass** |
| `pnpm test:cov` (full suite) | **11 failed / 3012 passed** — see below |

### On the full-suite failures

**Not a regression from this change, and pre-established as an environment problem before any source
file was touched.** `pause.md` recorded `11 failed | 3009 passed` on this same branch when the diff
was **docs-only with zero source changes**, and GitHub Actions was green on `d3f34c3`, the commit
this branch forks from — i.e. green on a byte-identical source tree. This run reports **the same 11
failures** (3012 passed = 3009 + the 3 tests added here).

The signature is machine load beating a 15s `testTimeout`, plus test-isolation leakage behind it:
one test times out and the *next* test in the same file then reads state left behind by it. The two
`list.test.ts` failures are exactly that pattern — test `1.` times out, and test `2.` then sees
`applied_filters.projects === undefined`. Both are `/all-tasks` tests that this change does not
touch, and the whole file passes 46/46 when run alone. Same shape in `move.test.ts` (`expected 99 to
be 42`), `comments/edit.test.ts` (`expected 'message' to be 'file'`), and the `windows-libuv-exit`
subprocess watchdog. Total wall time 756s for 4454s of test time.

**Every test added or modified by this run passed inside the loaded full run**, not just in
isolation. CI is the authoritative gate here (branch protection requires all 7 checks), and the
run's parameters explicitly instructed that this pre-existing condition not block the pipeline and
not be investigated further. It remains worth a separate issue if it reproduces on an idle machine.
