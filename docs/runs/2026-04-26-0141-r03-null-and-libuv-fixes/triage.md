# Triage — 2026-04-26-0141-r03-null-and-libuv-fixes

**Tier:** Yellow

## Rationale

Two patch-tier bug fixes triggered by a real-world user report on Windows.

- The schema relaxation only **broadens** the accepted shape of API responses.
  Anything that parsed yesterday still parses. The
  `freelo.projects.list/v1` envelope already declares `client` as object via
  `ProjectWithTasklistsSchema`; making it nullable in the inner shape is
  backwards-compatible — no consumer can have been relying on "client is
  never null", because the bug proves the field is null on real responses.
- The `handleTopLevelError` async conversion is local to the error path. It
  does not change exit codes, error messages, or envelope content. The
  `await` of `getGlobalDispatcher().close()` is bounded — undici closes its
  pool in milliseconds — and is wrapped in a try/catch so it cannot mask
  the original error's exit code.

Yellow (not Green) because:

- The error handler is in the critical path of every command.
- The envelope schema is a public contract — even though we are loosening,
  not tightening, this is a documented agreement with downstream agents
  and earns a human read on the PR.

## Route flags

- `needsSecurityReview`: false
- `requiresFreeloApi`: false (MSW + existing fixtures)
- `preApprovedDeps`: [] (no new deps; both fixes use existing imports
  — `undici` is already a direct dependency)
- `changesetLevel`: patch

## Phases to run

1. Spec → `docs/specs/0010-projects-list-null-and-libuv-fixes.md`
2. Plan → §8 of the spec
3. Implement → suggested split of two commits:
   - `fix(api): tolerate null in optional response fields`
   - `fix(errors): drain undici dispatcher before exit`
4. Test → null-client MSW handler + dispatcher-close spy
5. Review → code-reviewer (no security review)
6. Document → no user docs change; changelog is the doc
7. PR → `gh pr create`; auto-merge enabled (patch-tier, urgent, tested)

## Pre-approved decisions

- Broad sweep on every `.optional()` schema field in `src/api/schemas/`,
  capture as decision-log entry.
- Scope dispatcher drain to undici only; defer pino/keytar to future runs.
- Auto-merge enabled despite Yellow — patch-tier urgency justified.
