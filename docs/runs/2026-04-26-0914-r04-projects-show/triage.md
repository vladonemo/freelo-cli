# Triage — R04 `freelo projects show <id>`

**Run:** 2026-04-26-0914-r04-projects-show
**Tier:** Yellow

## Rationale

- New user-visible command (`freelo projects show <id>`) → minor / additive.
- New envelope schema `freelo.projects.show/v1` → public schema commitment, but additive.
- New `--with` flag (allow-list values: `workers`, `labels`).
- No new dependency. Reuses R03's HttpClient, pagination utilities (workers list endpoint may paginate), `cli-table3` table renderer.
- Touches **no** auth, no config, no HTTP client defaults, no release tooling.
- No breaking changes to existing envelope schemas, exit codes, or flag names.
- No security-sensitive surface (no auth, no token storage, no secret read/write).

## Triggers matched

- Yellow: new user-visible command (additive), new field/envelope schema (additive), changeset is `minor`.

## Route flags

- `requiresFreeloApi`: true (spawn `freelo-api-specialist` first to research `/project/{id}` and `/project/{id}/workers`)
- `needsSecurityReview`: false
- `preApprovedDeps`: [] (no new deps expected)

## Branch + commit

- Branch: `feat/projects-show` off `origin/main` (`17a7c72`).
- Commit count target: 1–2 (per orchestrator brief).

## Auto-merge

Branch protection on `main` now enforces all 7 CI status checks. Auto-merge only fires when CI is fully green. Per orchestrator brief, **enable auto-merge after green local gates** — auto-merge will block on red CI now that protection is configured.

## Pause-worthy paths

- API specialist surfaces something materially different from roadmap (e.g., labels need a separate undocumented endpoint, or `/project/{id}` response shape is unexpected) → re-evaluate tier.
- Architect wants to escalate beyond Yellow.
- Coverage drops below threshold and 2 retries cannot restore it.

```
TRIAGE run=2026-04-26-0914-r04-projects-show tier=Yellow new_deps=0 needsSecurityReview=false requiresFreeloApi=true
```
