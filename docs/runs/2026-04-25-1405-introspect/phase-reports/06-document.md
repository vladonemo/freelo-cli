# Phase 6 — Document

## Files added/modified
- `docs/commands/introspect.md` — new user-facing page with envelope shape, examples, exit codes.
- `docs/getting-started.md` — new "Agent discovery — `freelo --introspect`" section above "Next steps".
- `.changeset/introspect-r02-5.md` — `minor` bump per Yellow tier.

## Help text
- Root flag: `--introspect — Print the full command tree as a single JSON envelope (agent discovery).`
- Help subcommand: `help [commandPath...] — Print the command tree as JSON (--output json) or as the same text as --help (default).`

Verified visible in `freelo --help` output (full test pass).
