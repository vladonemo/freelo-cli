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

---

## Rollback

If autonomous merge lands a broken change:

1. `gh pr revert <PR>` — opens a revert PR
2. Run `/auto` again with the original requirement + "plus the constraints from incident <link>"
3. Post-incident, update `.claude/docs/autonomous-sdlc.md` if the class of failure should change tier gating

No auto-revert. The revert is itself a human call.
