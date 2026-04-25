# Requirement — R02.5 `freelo --introspect`

Roadmap entry (verbatim, `docs/roadmap.md` lines 80-95):

> **Outcome:** An agent can enumerate the entire CLI surface programmatically — every command, subcommand, flag, arg, output schema name, and destructive flag — without parsing `--help` text.
> **Endpoints:** none (local — walks the Commander program tree).
> **CLI:**
> ```
> freelo --introspect                          # single JSON envelope to stdout
> freelo help --output json                    # same content; agent-friendly alias
> freelo help <cmd> --output json              # scoped to one command
> ```
> **Output schema:** `freelo.introspect/v1` — `{ version, commands: [{ name, description, args, flags: [{ name, short, type, required, description, repeatable }], output_schema, destructive }] }`.
> **Ships with this slice:**
> - `src/lib/introspect.ts` — Commander tree walker.
> - Every command file is expected to declare `meta: { outputSchema, destructive }` (type-checked) so introspection is generated, never hand-maintained.
> - Golden-file test in `test/ui/introspect.test.ts` locks the envelope shape; future command additions update the golden.
> **Depends on:** R01.

## Run flags
- `--budget-minutes 30`
- `--allow-network false`
- `--ship false`
