# `freelo --introspect` and `freelo help`

Programmatically enumerate the entire CLI surface — every command, flag, argument, output schema, and `destructive` flag — as a single JSON envelope. Designed for agent tool-use manifests (MCP, Claude Code tool registries, custom CI scripts) that need a structured map of what `freelo` can do.

## Synopsis

```
freelo --introspect
freelo help                                # auto-resolves to JSON when stdout is not a TTY
freelo help --output json
freelo help <parent> --output json         # scope to a parent group's subtree, e.g. `freelo help config --output json`
freelo help <command...> --output json     # scope to a single leaf, e.g. `freelo help auth login --output json`
freelo help                                # human help text on a TTY (alias for `freelo --help`)
freelo help <command...>                   # human help text scoped to one command on a TTY
```

## Description

Walks the live Commander program tree at runtime — no hand-maintained list, no drift. Every leaf command file declares its `output_schema` and `destructive` boolean inline; the introspector reads them back and assembles the envelope.

The envelope schema is **`freelo.introspect/v1`**. As with every other public envelope in the CLI, additions are minor / non-breaking; field removal or rename will bump to `/v2` and ship a changeset.

Two equivalent entry points:

- **`freelo --introspect`** — root flag; always emits JSON regardless of TTY. Best for CI scripts and tool-manifest generation.
- **`freelo help [path...]`** — agent-friendly alias. Honors `--output`: `json` (or `auto` resolved to `json` because non-TTY) emits the envelope, `human` (or `auto` resolved to `human` because TTY) prints Commander's standard help text. The optional positional path scopes the output to one leaf.

Neither form makes any network call. The introspector is pure — no HTTP, no rate-limit metadata, no `request_id` from a remote server. (You can still pass `--request-id <uuid>` and have it round-trip on the envelope, mirroring the rest of the CLI.)

## Output schema — `freelo.introspect/v1`

```jsonc
{
  "schema": "freelo.introspect/v1",
  "data": {
    "version": "0.2.0",
    "commands": [
      {
        "name": "auth login", // space-joined command path
        "description": "Store credentials for a Freelo profile and verify them.",
        "args": [
          // positional, in declaration order
          // { "name": "key", "required": true, "variadic": false, "description": "" }
        ],
        "flags": [
          // sorted by long name
          {
            "name": "--email",
            "short": null,
            "type": "string", // 'boolean' | 'string' | 'string?' | 'string[]' | 'number'
            "required": false,
            "description": "Freelo account email address.",
            "repeatable": false,
          },
        ],
        "output_schema": "freelo.auth.login/v1",
        "destructive": false,
      },
    ],
  },
}
```

Commands are sorted ASCII-ascending by `name`. Flags within a command are sorted by long name. Arrays are always present — never omitted, even when empty.

## Examples

### List every command name

```bash
$ freelo --introspect | jq -r '.data.commands[].name'
auth login
auth logout
auth whoami
config get
config list
config profiles
config resolve
config set
config unset
config use
help
```

### Build a tool-use manifest for an MCP server

```bash
$ freelo --introspect > .mcp/freelo-tools.json
```

### Look up the destructive operations

```bash
$ freelo --introspect | jq '.data.commands[] | select(.destructive) | .name'
```

### Scoped help — by parent group

Pass a parent-group name and you get every leaf under that subtree, in one
envelope. Useful when an agent wants to enumerate the operations on one
resource without parsing the whole tree.

```bash
$ freelo help config --output json | jq -r '.data.commands[].name'
config get
config list
config profiles
config resolve
config set
config unset
config use

$ freelo help auth --output json | jq -r '.data.commands[].name'
auth login
auth logout
auth whoami
```

The match is exact on path-segment boundaries — `freelo help auth lo` is **not**
a partial-token match for `auth login`; it errors with `VALIDATION_ERROR` like
any other unknown path.

### Inspect a single command

```bash
$ freelo help auth login --output json | jq '.data.commands[0].flags'
[
  {
    "name": "--api-key-stdin",
    "short": null,
    "type": "boolean",
    "required": false,
    "description": "Read the API key from stdin (no echo). Requires --email.",
    "repeatable": false
  },
  {
    "name": "--email",
    "short": null,
    "type": "string",
    "required": false,
    "description": "Freelo account email address.",
    "repeatable": false
  }
]
```

### Diff before/after a feature

When a new command lands, the golden test in `test/ui/introspect.test.ts` will fail on purpose — that's the signal to update the snapshot. Agents that consume `freelo --introspect` can do the same: hash the output and check it into your tool registry alongside the CLI version.

## Exit codes

| Code | Meaning                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------ |
| 0    | Envelope written to stdout.                                                                                        |
| 2    | Unknown command path passed to `freelo help <path...>`. Error envelope on stderr (non-TTY) or human message (TTY). |

## Notes

- The `help` subcommand **is** included in the introspect output — its `output_schema` is `freelo.introspect/v1` (the entry is self-referential because `freelo help --output json` emits exactly that envelope). Agents walking `data.commands` therefore see a complete tool catalog.
- `--output ndjson` is rejected on `freelo help` for v1. Use `--output json`.
- The output never contains secrets (no tokens, no email addresses) — only command metadata.
