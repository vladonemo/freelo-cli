# Requirement — 2026-04-25-2110-help-introspect-meta

Decide and implement: should the `help` subcommand appear in `data.commands` of the
`freelo --introspect` envelope?

Today (0.3.2): `help` is excluded by design — `src/commands/help.ts` ends with a
comment explaining the exclusion is intentional ("would muddy the introspect
output (recursive entry for the help command itself)").

The R02.5 spec (`docs/specs/0004-introspect.md`) implies `help` should appear:
the example envelope in §2 includes a `help` entry, and there's no explicit
non-goal that excludes it.

So we have a spec/implementation gap. The architect resolves it.

## Run flags
- Budget: default (30m, 40 calls, 8 retries, 25 files)
- `--allow-network`: false
- `--ship`: false
