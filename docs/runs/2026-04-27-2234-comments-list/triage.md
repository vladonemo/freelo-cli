# Triage — 2026-04-27-2234-comments-list

**Tier:** Yellow (re-triaged after `/resume` with narrowed scope; original Red pause resolved by decision 1)
**Commit type:** feat

## Summary

R16 introduces `freelo comments list` — the first command in a new `comments` resource group. **Scope narrowed in resume** (decision `decisions/01-scope-narrow.md`):

- Maps to **`GET /all-comments` only**.
- `--task` dropped (deferred — no documented `GET /task/{task_id}/comments`).
- Flags: `--project` (repeatable), `--type`, `--order-by`, `--order`, `--page` / `--all`, plus client-side `--since`.

## Signals
- [x] Touches src/commands/ (new subcommand: `comments list`)
- [ ] Touches src/config/
- [ ] Touches src/api/client.ts or HTTP defaults
- [ ] Touches auth flows
- [ ] Adds a dependency
- [ ] Removes a dependency
- [x] Changes an envelope schema (new schema added — `freelo.comments.list/v1`)
- [ ] Changes exit codes
- [ ] Removes/renames an existing flag
- [x] Requires the Freelo API
- [ ] Docs-only

## Route flags
- requiresFreeloApi: true
- needsSecurityReview: false
- preApprovedDeps: []
- allowNewDeps: false

## Rationale

Read-only, additive, no auth/config touch, no new deps. New top-level `comments` resource group with one leaf in v1. Per `.claude/docs/autonomous-sdlc.md` Yellow triggers ("New user-visible command or flag (additive)" + "New field added to an envelope schema (backwards-compatible)" — actually a brand-new schema, still additive surface).

Original Red pause was resolved via `/resume` decision 1; the requirement / API mismatch has been narrowed to a documented endpoint with one explicitly client-side filter. No remaining unresolvable open questions.

## Recommended branch name

`feat/comments-list`
