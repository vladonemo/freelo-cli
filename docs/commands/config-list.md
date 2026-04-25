# freelo config list

List all configuration keys with their current effective values and sources.

## Synopsis

```bash
freelo config list
```

## What it does

Prints every key the CLI reads — writable and read-only — with the current resolved value and the source layer that produced it (`flag`, `env`, `rc`, `conf`, or `default`). No network call is made. `apiKey` always shows `[redacted]`; use `has_token` in `freelo config resolve` to check whether a token is present.

Writable keys appear first (alphabetical), then read-only keys (alphabetical). This order is stable and part of the envelope contract.

## Options

This command has no subcommand-specific flags. See [Getting started](../getting-started.md) for global flags (`--output`, `--profile`, `--color`, `-v`, `--request-id`).

## Examples

### Human invocation (TTY)

```bash
freelo config list
```

```
KEY          VALUE                           SOURCE   WRITABLE
apiBaseUrl   https://api.freelo.io/v1        default  yes
color        auto                            default  yes
output       json                            conf     yes
profile      ci                              env      yes
verbose      0                               default  yes
apiKey       [redacted]                      conf     no
email        agent@acme.cz                   conf     no
```

### Agent invocation (non-TTY, JSON output)

```bash
freelo config list --output json
```

```json
{
  "schema": "freelo.config.list/v1",
  "data": {
    "keys": [
      {
        "key": "apiBaseUrl",
        "value": "https://api.freelo.io/v1",
        "source": "default",
        "writable": true
      },
      { "key": "color", "value": "auto", "source": "default", "writable": true },
      { "key": "output", "value": "json", "source": "conf", "writable": true },
      { "key": "profile", "value": "ci", "source": "env", "writable": true },
      { "key": "verbose", "value": "0", "source": "default", "writable": true },
      { "key": "apiKey", "value": "[redacted]", "source": "conf", "writable": false },
      { "key": "email", "value": "agent@acme.cz", "source": "conf", "writable": false }
    ]
  },
  "request_id": "3f4a5b6c-7d8e-9f0a-bcde-f12345678901"
}
```

## Errors

| Code           | Exit | When                                                                  |
| -------------- | ---- | --------------------------------------------------------------------- |
| `CONFIG_ERROR` | 1    | The user conf store is corrupt or unreadable.                         |
| `CONFIG_ERROR` | 2    | A `.freelorc.*` file in the project tree has unknown or invalid keys. |

## See also

- [`freelo config get`](./config-get.md) — read a single key.
- [`freelo config set`](./config-set.md) — write a writable key.
- [`freelo config resolve`](./config-resolve.md) — full merged config with per-leaf source annotation.
- [Getting started](../getting-started.md)
