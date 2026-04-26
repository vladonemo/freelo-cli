# Triage — 2026-04-26-0838-restore-commands-coverage

**Tier:** Green

## Rationale

- Test-only additions; zero source change under `src/`.
- No new dependencies.
- No envelope schema, exit code, flag rename, or behavior change.
- No auth/config/HTTP-defaults/release tooling change.
- Reviewer is unlikely to find blocking findings on test-only additions.
- Security auditor not triggered.
- Coverage thresholds restored to their target.

## Route flags

- `needsSecurityReview`: false
- `requiresFreeloApi`: false
- `preApprovedDeps`: []
- `autoMerge`: enabled (Green default)

## Pause-worthy

- Coverage stays below threshold after 2 retries → pause.
- A test requires source-code change to make a branch reachable → pause (signals dead code).
- Any of the five gates fails for a non-coverage reason → pause.
- Non-flaky test failure introduced → pause.
