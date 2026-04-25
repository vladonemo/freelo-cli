# Phase 3 — Implement

**Branch:** `feat/introspect`

## Files added
- `src/lib/introspect.ts` — `CommandMeta` type, `attachMeta`/`readMeta` helpers, `walkProgram`, `buildIntrospectData`, `filterByPath`.
- `src/commands/help.ts` — Commander `help [commandPath...]` subcommand. Emits envelope on json mode, delegates to `outputHelp()` on human mode, rejects ndjson with `VALIDATION_ERROR`.

## Files modified
- `src/bin/freelo.ts` — added `--introspect` global flag, registered `help` command, added root-level default action that emits the envelope when `--introspect` is set.
- `src/commands/auth/{login,logout,whoami}.ts` — typed `meta` against `CommandMeta`, called `attachMeta(cmd, meta)`. No behavior change.
- `src/commands/config/{get,list,set,unset,profiles,use,resolve}.ts` — same.

## Quality gates
- `pnpm typecheck` → pass.
- `pnpm lint` → pass.
- No new runtime deps; no human-UX deps imported on the agent path.

## Stuck-loop / retry: none. First typecheck attempt surfaced two issues (Argument._name access, unused `helpCmd`), both fixed in single edits.
