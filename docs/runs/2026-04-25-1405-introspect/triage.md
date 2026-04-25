# Triage — 2026-04-25-1405-introspect

**Tier:** **Yellow**

## Triggers (per `.claude/docs/autonomous-sdlc.md` §Risk tiers)

Yellow triggers that apply:
- **New user-visible flag** — root-level `--introspect`, plus `help <cmd> --output json` semantic.
- **New envelope schema** (`freelo.introspect/v1`) — additive, backwards-compatible.
- **Changeset will be `minor`** — new public surface.

Red triggers explicitly checked and **not** matched:
- Does not touch `src/config/`, `src/api/client.ts`, auth flows, TLS/retry/redirect defaults.
- No breaking change to existing flag names, exit codes, or envelope schemas (`freelo.config.<op>/v1`, `freelo.auth.<op>/v1` round-trip identically — they are *consumed* read-only via `meta.outputSchema`).
- No dependency add/remove/major bump (`commander` already exposes the tree).
- No security-sensitive surface (no auth, HTTP, secret material).

Green triggers explicitly checked and **not** matched:
- Yellow-level user-visible additions disqualify Green.

## Route flags

- `needsSecurityReview: false` — no auth/HTTP/secret/config surface touched.
- `requiresFreeloApi: false` — local-only, walks the in-memory Commander tree.
- `preApprovedDeps: []` — no new runtime deps required.
- `crossCutting: true (low-risk)` — every `src/commands/*.ts` and parent file (`auth.ts`, `config.ts`) must export a `meta` literal. Leaf files already do (verified). Parent files (`auth.ts`, `config.ts`) need to be added (no behavior change — the parent commands are containers, not action commands; their `meta` is informational).

## Rationale

R02.5 is a small, additive, agent-discovery slice with **no user-data path** and **no network**. Existing infra carries it: `meta` is already declared on all 10 leaf command files (R01/R02 spec §2.1 made that decision). The remaining work is a Commander walker, root-flag wiring, golden test, and docs. Crosscutting "every command file gets `meta`" is mostly already done — only the two parent files (`auth`, `config`) need to be brought into compliance, and those are container commands so the type-mandatory rule must be applied carefully (see decision log).

## Outcome

Yellow flow: full pipeline → open PR → leave for human review and merge. Do **not** auto-merge.
