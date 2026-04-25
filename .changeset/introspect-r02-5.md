---
'freelo-cli': minor
---

Add `freelo --introspect` and `freelo help --output json` (R02.5).

Agents and CI scripts can now enumerate the entire CLI surface programmatically — every command, flag, argument, output schema, and `destructive` boolean — as a single `freelo.introspect/v1` envelope. The introspector walks the live Commander tree, so future commands light up automatically with no hand-maintained list.

- `freelo --introspect` — single JSON envelope to stdout, one line, exit 0. Loads no human-UX dependencies.
- `freelo help --output json` — agent-friendly alias for the full envelope.
- `freelo help <command...> --output json` — scoped to a single leaf.
- Every leaf command file now exports `meta: CommandMeta` (`{ outputSchema, destructive }`), type-checked at compile time.

New envelope schema: `freelo.introspect/v1`. No existing schemas changed.
