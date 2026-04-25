# freelo config profiles

List all configured profiles and show which one is currently active.

## Synopsis

```bash
freelo config profiles
```

## What it does

Reads the user conf store and returns every profile that has been created via `freelo auth login`. No network call is made and no credentials are decrypted. The `current` field marks which profile is active.

## Options

This command has no subcommand-specific flags. See [Getting started](../getting-started.md) for global flags (`--output`, `--profile`, `--color`, `-v`, `--request-id`).

## Examples

### Human invocation (TTY)

```bash
freelo config profiles
```

```
* ci       agent@acme.cz   https://api.freelo.io/v1
  default  jane@acme.cz    https://api.freelo.io/v1
```

The `*` marks the active profile.

### Agent invocation (non-TTY, JSON output)

```bash
freelo config profiles --output json
```

```json
{
  "schema": "freelo.config.profiles/v1",
  "data": {
    "current_profile": "ci",
    "profiles": [
      {
        "name": "default",
        "email": "jane@acme.cz",
        "api_base_url": "https://api.freelo.io/v1",
        "current": false
      },
      {
        "name": "ci",
        "email": "agent@acme.cz",
        "api_base_url": "https://api.freelo.io/v1",
        "current": true
      }
    ]
  },
  "request_id": "2b3c4d5e-6f7a-8901-bcde-f01234567890"
}
```

`current_profile` is `null` when no profile has been set as active.

## Errors

| Code           | Exit | When                                          |
| -------------- | ---- | --------------------------------------------- |
| `CONFIG_ERROR` | 1    | The user conf store is corrupt or unreadable. |

## See also

- [`freelo config use`](./config-use.md) — switch the active profile.
- [`freelo auth login`](./auth-login.md) — create a new profile.
- [`freelo auth logout`](./auth-logout.md) — remove a profile.
- [Getting started](../getting-started.md)
