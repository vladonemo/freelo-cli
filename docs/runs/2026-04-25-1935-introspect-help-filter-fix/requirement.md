# Requirement — Introspect help parent-group filter fix

## Source
Real bug published in `freelo-cli@0.3.0`.

## Reproduction
```
$ npx freelo-cli@0.3.0 help config --output json
freelo error: Unknown command 'config'.
$ echo $?
2
```

`freelo help auth --output json` fails identically. Only fully-qualified leaves work
(`help auth login --output json`).

## Root cause
`filterByPath` in `src/lib/introspect.ts` does an exact-match lookup against
`commands[].name`. The introspect data structure stores leaves only — never parent
groups. So `help config --output json` finds zero matches and throws
`VALIDATION_ERROR` with exit 2.

## Expected behavior
`freelo help <parent> --output json` returns the introspect envelope scoped to the
parent's subtree — every leaf whose name is `<parent>` itself OR starts with
`<parent> `. Leaves keep working.

## Constraints
- No envelope schema change (`freelo.introspect/v1` stays).
- No new parent-group entries in the flat `data.commands` list.
- `help` is still excluded as a leaf in the introspect output (existing behavior).

## Risk tier
Likely Green (mechanical bugfix, patch).
