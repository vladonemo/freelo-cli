# Autonomous SDLC

Companion to `.claude/docs/sdlc.md`. Same seven phases, same agents — **no human gates between phases** in the default flow. A single command (`/auto <requirement>`) runs the pipeline end-to-end, pausing only on conditions defined here.

## When to use which mode

- **Interactive mode** (`/spec` → `/plan` → `/implement` → …): when you want a human gate between phases. Use for first-of-a-kind work, risky changes, or when you want to learn the codebase alongside the agents.
- **Autonomous mode** (`/auto <requirement>`): when the requirement is well-scoped and you trust the risk-tier gating below. Throw in a requirement, get back either a merged PR or a clearly documented pause.

Both modes produce the same artifacts (spec, plan, code, tests, docs, changeset).

---

## The orchestrator loop

The `orchestrator` agent drives the pipeline:

```
1. triage            → risk tier + route
2. architect         → spec
3. architect         → plan
4. implementer       → code (on a branch)
5. test-writer       → tests
6. run pnpm lint/typecheck/test       (loop 2–4 if red)
7. code-reviewer     → findings
8. security-auditor  → findings (if triggered by triage)
9. address blocking findings          (loop back to 4–6)
10. doc-writer        → docs
11. commit, push, open PR
12. risk-tier gate    → merge / pause
13. ship               (gated — off by default)
```

Each step emits a **phase report** to `docs/runs/<run-id>/` and updates the decision log.

---

## Risk tiers

Triage assigns one on intake. Every change carries exactly one tier — when multiple signals conflict, the highest tier wins.

### Green — runs all the way through merge

Triggers (all must hold):
- Change touches **no** auth, config, HTTP client defaults, or release tooling
- No new runtime dependencies
- No breaking change to envelope schema, exit codes, or flag names
- Reviewer finds no Blocking items
- Security auditor not triggered OR only Informational findings
- Test coverage meets targets

Flow: full pipeline → open PR → **enable auto-merge** (squash) → CI green → merged. Human sees the result, not the in-flight work.

Examples: doc edits, internal refactor, new read-only subcommand, test additions.

### Yellow — runs through PR, stops before merge

Triggers (any):
- New user-visible command or flag (additive)
- New field added to an envelope schema (backwards-compatible)
- New Medium-level security finding
- New non-security dependency
- Changeset is `minor`

Flow: full pipeline → open PR → leave for human review and merge.

### Red — pauses and asks before continuing

Triggers (any):
- Touches `src/config/`, auth flows, `src/api/client.ts`, TLS/retry/redirect defaults
- Any security auditor **Critical** finding
- Breaking change (removed flag, changed exit code, changed envelope schema)
- Dependency removal or major bump
- Changeset is `major`
- Spec has unresolvable Open questions
- Requirement itself is ambiguous about scope or UX

Flow: orchestrator runs up to the ambiguity, then **pauses** with a structured report. The human resolves via `/resume`.

---

## Pause protocol

When the orchestrator pauses, it writes to stdout and to `docs/runs/<run-id>/pause.md`:

```
## Paused at <phase>

**Run:** <run-id>
**Reason:** <one sentence>
**Risk tier:** Red | (unexpected block from Green/Yellow)

### What happened
<2–4 sentences of context>

### Evidence
- <file:line or log excerpt>
- <fixture path>

### Decision needed
<Specific question>

Options:
  A. <option> — tradeoff
  B. <option> — tradeoff
  C. Abort the run

### Resume with
/resume <run-id> <A|B|C or free-form answer>
```

The human answers, `/resume` feeds the answer back into the paused phase, and the pipeline continues.

**Never** pause silently — every pause has this report. When `/auto` is run with `--output json`, the pause record is included in the final envelope.

---

## Autonomous decisions vs. pauses

The orchestrator and its sub-agents make decisions autonomously; pausing is the exception. Rule of thumb:

| Decision type | Action |
|---|---|
| Internal naming (file, var, type) | Decide, log |
| Small UX choices with a clear precedent in the codebase | Decide, log |
| Zod schema shape when spec is present | Decide, log |
| Choice between two tests that prove the same thing | Decide, log |
| New user-facing flag name or short form | Decide, log, flag for review in PR body |
| Breaking behavior of an existing command | **Pause** |
| Storage of a new secret | **Pause** |
| Adding a new dependency | **Pause unless** triage marked pre-approved |
| API behavior not in `docs/api/freelo-api.yaml` | **Pause** (don't guess the API) |
| Business question ("should we support X for free-tier users?") | **Pause** |

Every autonomous decision is written to `docs/decisions/<run-id>-<n>.md` with: what was decided, what alternatives were considered, why this one, and which agent decided. This is the audit trail.

---

## Self-correction loops

Some phases retry on failure instead of pausing.

| Phase | Retry trigger | Max | On exhaust |
|---|---|---|---|
| Implementer | `pnpm typecheck` or `pnpm lint` fails | 3 | Pause with failure details |
| Implementer + test-writer | `pnpm test` fails | 3 | Pause with failing test output |
| Implementer | code-reviewer Blocking findings | 2 | Pause with findings |
| Test-writer | coverage below target | 2 | Pause unless reviewer waives |

Retries must make **progress** — identical failure two iterations in a row pauses immediately (stuck-loop detection). The orchestrator diffs the error output to detect this.

---

## Budget caps

Hard limits per run. The orchestrator tracks them and pauses when exhausted.

| Resource | Default | Override |
|---|---|---|
| Wall clock | 30 min | `--budget-minutes` |
| Agent invocations | 40 | `--budget-calls` |
| Phase retries (total across phases) | 8 | `--budget-retries` |
| Files touched | 25 | `--budget-files` |

When a budget is exhausted, the orchestrator finishes the current agent call, writes the pause report, and stops. Partial work is committed to the branch so nothing is lost.

---

## What never runs autonomously

Hard gates — no `--force` overrides these:

- **`npm publish`** — `/ship` is gated even in autonomous mode. Override via project config `autonomous.autoShip: true` (not recommended for v1).
- **`git push --force`** to any branch.
- **Writes outside the repo** — no changes to `~/.*` config, no `npm login`, no global installs.
- **Real Freelo API calls against production data** — autonomous runs use MSW for tests and the cached OpenAPI spec for design. A real-API call requires `--allow-network` plus a dedicated test account.
- **Destructive git ops** on unmerged work — no `reset --hard`, no branch deletes without explicit confirmation.
- **Accepting a security Critical finding** — always pauses, no auto-proceed option.

---

## Run artifacts

Every `/auto` run creates `docs/runs/<run-id>/`:

```
docs/runs/2026-04-24-1430-auth-login/
├── requirement.md          original input
├── triage.md               tier + rationale
├── spec.md                 symlink to docs/specs/...
├── phase-reports/
│   ├── 01-triage.md
│   ├── 02-spec.md
│   ├── 03-plan.md
│   ├── 04-implement.md
│   └── ...
├── decisions/              autonomous decisions made this run
├── pause.md                present only if the run paused
└── summary.md              final report with links
```

`run-id` format: `YYYY-MM-DD-HHMM-<slug>`. This is the only thing a human needs to audit a run.

---

## Observability

During a run, the orchestrator prints a live progress line:

```
[run 2026-04-24-1430-auth-login] phase 4/13 implement · 2/3 retries · 18:23 elapsed
```

At each phase boundary, a one-line summary:

```
✓ phase 2 spec — docs/specs/0001-auth-login.md (112 lines)
✓ phase 3 plan — 6 files, 2 tests, no new deps
✓ phase 4 implement — 5 files changed, 1 retry (typecheck)
...
```

Full detail goes to `docs/runs/<run-id>/phase-reports/`. The live output is scannable; the reports are auditable.

---

## Resuming

```
/resume <run-id> <answer>
```

- The orchestrator reads `pause.md`, appends the answer to the decision log, and re-enters the paused phase with the new input.
- If the answer changes scope (e.g., "actually don't do X"), the orchestrator re-runs triage and the spec phase with the updated requirement.
- Multiple pauses in one run are fine — each has its own entry in the decision log.

---

## Failure modes and responses

| Symptom | Response |
|---|---|
| Stuck retry loop | Pause with last two failure outputs diffed |
| API rate-limited MSW unexpectedly (shouldn't happen) | Pause — MSW misconfig |
| Plan drift: implementer needs files not in plan | Pause — plan is the contract |
| Changeset action fails | Pause before push, investigate |
| Git push rejected (remote ahead) | Pause — rebase is a human call |
| Spec says something the OpenAPI spec contradicts | Pause — Freelo's contract is authoritative |
| Agent rate-limited mid-implementation | Halt; do **not** skip remaining phases when resuming manually (see Calibration §1) |

---

## Calibration log

Lessons learned from real autonomous runs. Each entry is a class-of-failure and the rule it added.

### 1. Mid-run rate-limit / manual takeover must not skip the test phase

**Trigger:** R04 (`projects show`) — orchestrator hit a rate limit mid-implementation. Source files were on disk, MSW handlers and fixtures were ready, but no test file existed yet. Manual takeover was tempted to commit-and-ship with just typecheck/lint passing.

**Why it matters:** The test phase isn't optional. Writing the test file caught a real source-code bug — `parseProjectId` threw Commander's `InvalidArgumentError` (which falls through to exit 1) when the spec contract demanded `ValidationError` (exit 2). Without exit-code assertions, the bug would have shipped to npm with the wrong observable behavior on every invalid `<id>`.

**Rule:** When any phase is interrupted (rate limit, pause-and-resume, fresh orchestrator with prior state), the human or new orchestrator MUST run every remaining phase — including test, review, document — before pushing. The "what's still missing" list at takeover time is the contract; do not shortcut.

### 2. Exit-code assertions are non-negotiable on error paths

**Trigger:** R04 — same `parseProjectId` bug as above. Six happy-path-shaped tests passed. Two error-path tests (non-numeric `<id>`, zero `<id>`) caught `exitCode: 1` where spec said `exitCode: 2`.

**Why it matters:** The exit code is a public contract. Agents script around it (`exit 2 → user input was invalid; reprompt`). Shipping the wrong code is silently breaking integrations.

**Rule:** Every error path that the spec assigns an exit code MUST have a test asserting that exit code. The test-writer agent's coverage targets must include exit-code assertions, not just "an error envelope was emitted". For every typed error class (`ValidationError`, `FreeloApiError`, `NetworkError`, `RateLimitedError`, `ConfirmationError`, `ConfigError`), at least one test in the slice must trigger that class and assert its `exitCode`.

### 3. Run gates AFTER commit, on the clean committed tree

**Trigger:** R02.5 (`--introspect`) — orchestrator reported `pnpm typecheck` clean during implement; CI on all 9 matrix jobs went red on `tsc`. Self-check ran on a working-tree snapshot before the final test-file edit.

**Why it matters:** A working-tree snapshot can disagree with the committed state. Local-gate-passes-but-CI-red is the worst kind of mismatch: it suggests discipline that doesn't actually exist.

**Rule:** After every commit, before push: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`. Run on the **committed** tree (clean `git status`), not the working tree mid-edit. Push only when all five pass. **Branch protection on `main` now enforces the CI-equivalent server-side**, but local discipline still matters for fast feedback and to avoid round-tripping CI failures.

### 4. New `try/catch` wrappers add untested branches → coverage drift

**Trigger:** R03 + R02.5 (`null+libuv` fix) — added `await drainDispatcher()` inside every error-path catch block across multiple command handlers. Branch coverage dropped from 95% to 73-82% on individual files; aggregate `src/commands/**` branches fell from green to 82.72% (threshold 85%). Main was red for several merge cycles before the gap was noticed during a release-manager run.

**Why it matters:** A small "fix" that touches many files can quietly invalidate coverage targets. With branch protection now active, this becomes a hard merge gate — but the orchestrator can still write a PR that won't merge until tests catch up.

**Rule:** Any change that adds `try/catch` blocks, conditional cleanup, or new error-path branches across 3+ files must include test cases for each new catch arm. The implementer agent should grep its diff for `catch (` and `await drainDispatcher` introductions and ensure the test plan covers each new arm before declaring the implement phase done.

### 5. CI must be a required status check on `main`

**Trigger:** PRs #22 and #24 auto-merged onto a red CI on `main` because the `ci` workflow wasn't a required check. The release workflow doesn't gate on CI either, so a broken-coverage main shipped `0.5.1` to npm with tests failing.

**Why it matters:** Auto-merge through red CI defeats the purpose of CI. One-time gap, but a real one.

**Rule:** `main` branch protection requires all 7 CI status checks (matrix + `check README autogen`). Configured 2026-04-26. If branch protection is ever disabled, that's a red flag — escalate before merging anything.

### 6. Inline mid-flow PRs must branch from `main`, not current HEAD

**Trigger:** PR #35 (a small `docs/release-admin-merge-exception` skill update) was created with `git checkout -b docs/release-admin-merge-exception` while local HEAD was on `feat/tasklists-show` — the R06 orchestrator's branch. PR #35's tree therefore carried R06's content + the skill edit. PR #34 (Version Packages → 0.9.0) merged in between PR #35's open and merge, deleting the consumed changeset on `main`. When PR #35 squash-merged onto post-#34 `main`, it **re-introduced** the deleted changeset. `changesets-action` then opened PR #36 (Version Packages → 0.10.0) and shipped a no-op `0.10.0` to npm — byte-identical content to `0.9.0`, just a version-history doppelgänger.

**Why it matters:** Autonomous runs spawn agents that switch branches on the shared working tree. After the orchestrator finishes, local HEAD is typically NOT on `main`. Branching from "wherever I am" silently inherits the agent's branch — sometimes harmless, sometimes (as here) it bridges deleted-state changes back into a future merge.

**Rule:** Before opening any inline PR mid-session — especially small docs/chore edits during or after an autonomous run — **always sync to `main` first**:

```bash
git checkout main
git pull --ff-only origin main
git checkout -b <new-branch>
```

Never trust `git checkout -b <new-branch>` alone after agent activity. If two PRs touch the `.changeset/` directory near in time, the merge order is load-bearing — verify the second-merging PR's diff against post-first-merge `main` before enabling auto-merge.

Cost of the mistake here was minor (cosmetic version-history noise; `0.10.0 == 0.9.0` content). Cost in a worse scenario could be republishing already-deleted changesets, double-billing minor bumps, or accidentally consuming a NEW changeset that was added between the two PRs.

### 7. Tests for TTY-prompt code paths must unset `CI`, not just override `isTTY`

**Trigger:** R23 (`feat/labels`, PR #68) — `test/commands/labels/delete.test.ts` "confirmation copy explicitly says 'GLOBALLY' in TTY mode" passed locally on the orchestrator's machine (no `CI` env var set) but failed on every job in the GitHub Actions matrix. The test forced `process.stdout.isTTY = true` and `process.stdin.isTTY = true`, then mocked `@inquirer/prompts.confirm` and asserted the captured prompt message contained "GLOBALLY". In CI, the mock was never called and `captured` stayed empty.

**Why it matters:** `src/lib/env.ts` `isInteractive()` is the gate in front of every lazy human-UX import. It returns `false` when **either** stream is not a TTY **or** `process.env.CI` is set to a truthy value (`'true'`, `'1'`, anything not `'0'`/`'false'`). GitHub Actions sets `CI=true` unconditionally, so on the matrix `isInteractive()` returned `false` regardless of the spoofed `isTTY` flags. The non-TTY branch of `confirmDestructive` threw `ConfirmationError` synchronously before the lazy `await import('@inquirer/prompts')` ever ran. exit code 2 still matched the assertion (red herring), so the only signal was the empty `captured` string.

The orchestrator's self-check ran locally where `CI` is unset, so the test passed and the run shipped a green PR that went red on push. Calibration #3 (run gates on the committed tree) doesn't catch this — both committed-tree and working-tree pass locally. The class of bug is "test environment mimics CI partially."

**Rule:** When a test asserts behavior on the **TTY-prompt code path** (i.e. the path gated by `isInteractive()`), it MUST save and clear `process.env.CI` for the duration of the test, then restore it in `finally`. Spoofing `process.stdout.isTTY` / `process.stdin.isTTY` alone is **not sufficient** because `isInteractive()` short-circuits on `CI`. Pattern (mirrors `test/lib/env.test.ts:50-58`):

```ts
const savedCI = process.env['CI'];
delete process.env['CI'];
Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
try {
  // ... test that exercises the TTY-prompt branch ...
} finally {
  if (savedCI !== undefined) process.env['CI'] = savedCI;
}
```

The test-writer agent should grep its diff for `isTTY.*true` in test files and verify that any matching test also clears `CI`. Better still: assert the prompt copy at the helper level (export and unit-test the message-builder) where the `isInteractive()` gate doesn't apply at all — but when an integration test is genuinely the right level, clear `CI` explicitly.

Future calibration candidate: add an `it.runIfCI` / `it.skipIfCI` or shared `withTtyPromptable()` helper to make this footgun harder to step on.

---

## Rollback

If autonomous merge lands a broken change:

1. `gh pr revert <PR>` — opens a revert PR
2. Run `/auto` again with the original requirement + "plus the constraints from incident <link>"
3. Post-incident, update `.claude/docs/autonomous-sdlc.md` if the class of failure should change tier gating

No auto-revert. The revert is itself a human call.
