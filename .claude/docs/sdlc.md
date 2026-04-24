# Agentic SDLC — Freelo CLI

This is the canonical development process. Every non-trivial change goes through it. Small changes (typos, dependency bumps) can skip phases but still need a changeset and a passing CI.

The process is **agentic**: each phase has a dedicated agent with a narrow mandate and a slash command that invokes it. Phases are gates, not suggestions — don't implement before planning, don't ship before reviewing.

## Two operating modes

- **Interactive** (this doc): phase-by-phase slash commands with human gates between phases. Use for risky or first-of-a-kind work.
- **Autonomous** (`.claude/docs/autonomous-sdlc.md`): one command (`/auto <requirement>`) runs the full pipeline with an orchestrator, pausing only on policy triggers.

Both modes produce the same artifacts (spec, plan, code, tests, docs, changeset) and use the same specialist agents. They differ only in where the human sits.

---

## Phase 0 — Intake

**Trigger**: an issue, a user request, or a bug report.

**Output**: one of
- a linked GitHub issue with a `type:` label (`feat`, `fix`, `chore`, `docs`, `refactor`)
- a rejection with reasoning

**Who**: the human maintainer.

No code is written in this phase. If scope is unclear, it goes back to the requester with questions.

---

## Phase 1 — Discover / Specify

**Command**: `/spec <issue-or-description>`
**Agent**: `freelo-api-specialist` (for API-touching work) + `architect`

Turn the request into a written **spec** stored under `docs/specs/NNNN-<slug>.md`. A spec includes:

- **Problem**: what the user can't do today
- **Proposal**: the CLI UX — exact subcommand, flags, arguments, example invocations
- **API surface**: which Freelo endpoints are involved; link to the official docs
- **Data model**: zod schemas for inputs and API responses (just the sketch)
- **Edge cases**: pagination, rate limits, partial failures, auth expiry
- **Non-goals**: what we're deliberately not doing
- **Open questions**: things the human needs to decide

Specs are reviewed by a human before Phase 2. A rejected spec goes back to Phase 0.

---

## Phase 2 — Plan

**Command**: `/plan <spec-path>`
**Agent**: `architect`

Produce an **implementation plan** as a checklist inside the spec file (append a `## Plan` section). The plan must enumerate:

- Files to create or modify with one-line intent
- New dependencies to add and why (or an explicit "no new deps")
- Test strategy: which tests are unit vs. integration, which MSW handlers are needed
- Rollout order: if the change is large, break it into landable slices that each pass CI

The plan is the contract. If implementation deviates, the plan is updated first.

---

## Phase 3 — Implement

**Command**: `/implement <spec-path>`
**Agent**: `implementer`

Write the code against the plan. Rules:

- Work on a branch named `<type>/<slug>` (e.g. `feat/tasks-list`)
- One phase per commit when practical; Conventional Commits required
- Never skip the pre-commit hook
- If blocked, update the spec's **Open questions** and stop — don't improvise

Deliverables:
- Code under `src/`
- Type-level zod schemas for any new API surface
- Help text for any new subcommand/flag

---

## Phase 4 — Test

**Command**: `/test [path]`
**Agent**: `test-writer`

Two layers, both with `vitest`:

- **Unit**: pure functions, renderers, error formatting. Fast, no I/O.
- **Integration**: full command invocation with `msw` mocking the Freelo API. Covers the golden path and the main error branches (401, 403, 404, 429, 5xx, network error).

Coverage target: **80% lines, 90% on `src/api/` and `src/commands/`**. Don't chase 100% — skip trivial getters.

Snapshot tests are allowed for table rendering but must be reviewed on update.

---

## Phase 5 — Review

**Command**: `/review`
**Agent**: `code-reviewer`

A self-review before the human review. Checks:

- Plan adherence
- No `any`, no un-validated API responses, no bare `throw new Error`
- `--json` output supported
- Help text present and accurate
- Changeset entry added
- No secrets in fixtures

**Command**: `/security-review` (required for any change touching `src/config/` or auth flows)
**Agent**: `security-auditor`

After self-review, open a PR. The `review` skill and the repo's CODEOWNERS trigger human review.

---

## Phase 6 — Document

**Command**: `/document <spec-path>`
**Agent**: `doc-writer`

User-facing documentation lives in `docs/` (rendered by VitePress later). Every new subcommand needs:

- A page under `docs/commands/<cmd>.md`
- At least two realistic examples
- A note about required scopes/permissions on the Freelo side
- Update `docs/getting-started.md` if the command is something a new user would reach for

Generated `--help` output should read cleanly on its own — docs supplement, they don't replace help text.

---

## Phase 7 — Ship

**Command**: `/ship`
**Agent**: `release-manager`

Release flow:

1. Merge PR to `main` (squash merges; PR title must be a Conventional Commit)
2. `changesets` action opens/updates a "Version Packages" PR
3. Merging the version PR triggers `npm publish` from CI
4. Tag is pushed, GitHub Release is created with the changelog
5. Announcement (if feature-level): a one-line note in `CHANGELOG.md` highlights

Versioning is **SemVer**. Pre-1.0: breaking changes bump minor, per changesets convention.

---

## When things go wrong

- **Bug in production**: open an issue with `type: fix`, go through the full flow but compress Phases 1–2 into a brief spec. Still write a regression test in Phase 4.
- **Security issue**: do **not** open a public issue. Email the maintainer, follow `SECURITY.md` once it exists, and ship through a private branch.
- **Plan drift mid-implementation**: stop, update the plan, reconverge with a human if the change is material.

---

## Responsibility matrix

| Phase | Command | Agent | Human gate? |
|---|---|---|---|
| 0 Intake | — | — | yes |
| 1 Spec | `/spec` | `freelo-api-specialist`, `architect` | yes |
| 2 Plan | `/plan` | `architect` | yes |
| 3 Implement | `/implement` | `implementer` | no |
| 4 Test | `/test` | `test-writer` | no |
| 5 Review | `/review`, `/security-review` | `code-reviewer`, `security-auditor` | yes (PR) |
| 6 Document | `/document` | `doc-writer` | yes |
| 7 Ship | `/ship` | `release-manager` | yes (merge version PR) |
