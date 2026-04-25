# freelo config get

Get the current value and source of a single configuration key.

## Synopsis

```bash
freelo config get <key>
```

## What it does

Looks up `<key>` in the resolved configuration and returns its current value, the source layer that produced it, and whether it is writable. No network call is made.

`apiKey` is a valid key. It returns `value: "[redacted]"` — the literal string — and `writable: false`. Use `has_token` in `freelo config resolve` to check whether a real token is stored.

`verbose` returns a string (`"0"`, `"1"`, or `"2"`) on the wire, even though it is stored as a number internally.

An unknown key is an error (`VALIDATION_ERROR`, exit 2). Run `freelo config list` to see all known keys.

## Options

This command has no subcommand-specific flags. See [Getting started](../getting-started.md) for global flags (`--output`, `--profile`, `--color`, `-v`, `--request-id`).

## Examples

### Human invocation (TTY)

```bash
freelo config get output
```

```
output: json (source: conf)
```

### Agent invocation (non-TTY, JSON output)

```bash
FREELO_PROFILE=ci freelo config get profile --output json
```

```json
{
  "schema": "freelo.config.get/v1",
  "data": { "key": "profile", "value": "ci", "source": "env", "writable": true },
  "request_id": "7e6f0c3e-2a3b-4c1d-8e9f-0a1b2c3d4e5f"
}
```

### Reading a key set by the rc file

```bash
freelo config get output --output json
```

```json
{
  "schema": "freelo.config.get/v1",
  "data": { "key": "output", "value": "ndjson", "source": "rc", "writable": true },
  "request_id": "1a2b3c4d-5e6f-7890-abcd-ef0123456789"
}
```

### Reading a read-only key

```bash
freelo config get apiKey --output json
```

```json
{
  "schema": "freelo.config.get/v1",
  "data": { "key": "apiKey", "value": "[redacted]", "source": "conf", "writable": false },
  "request_id": "2b3c4d5e-6f7a-8901-bcde-f01234567890"
}
```

## Errors

| Code               | Exit | When                                                                  |
| ------------------ | ---- | --------------------------------------------------------------------- |
| `VALIDATION_ERROR` | 2    | `<key>` is not a known configuration key.                             |
| `CONFIG_ERROR`     | 1    | The user conf store is corrupt or unreadable.                         |
| `CONFIG_ERROR`     | 2    | A `.freelorc.*` file in the project tree has unknown or invalid keys. |

## See also

- [`freelo config list`](./config-list.md) — list all keys at once.
- [`freelo config set`](./config-set.md) — write a writable key.
- [`freelo config unset`](./config-unset.md) — remove a stored value and fall back to the default.
- [Getting started](../getting-started.md)
