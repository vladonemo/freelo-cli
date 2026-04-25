# freelo config use

Switch the active profile.

## Synopsis

```bash
freelo config use <profile>
```

## What it does

Sets `<profile>` as the active profile in the user conf store. No network call is made — the command only moves a pointer. Run `freelo auth whoami` afterward to verify the profile's credentials are still valid.

The profile must already exist. Use `freelo auth login --profile <name>` to create one.

The operation is idempotent: switching to the already-active profile exits 0 with `changed: false`.

## Options

This command has no subcommand-specific flags. See [Getting started](../getting-started.md) for global flags (`--output`, `--profile`, `--color`, `-v`, `--request-id`).

## Examples

### Human invocation (TTY)

```bash
freelo config use ci
```

```
Switched profile: default -> ci.
```

### Agent invocation (non-TTY, JSON output)

```bash
freelo config use ci --output json
```

```json
{
  "schema": "freelo.config.use/v1",
  "data": {
    "previous_profile": "default",
    "profile": "ci",
    "changed": true
  },
  "request_id": "8b2a1c3d-4e5f-6789-abcd-ef0123456789"
}
```

### Idempotent (profile already active)

```bash
freelo config use ci --output json
```

```json
{
  "schema": "freelo.config.use/v1",
  "data": {
    "previous_profile": "ci",
    "profile": "ci",
    "changed": false
  },
  "request_id": "9c3b2d1e-5f6a-789b-cdef-0123456789ab"
}
```

Exit code 0 in both cases.

### Error: profile does not exist

```bash
freelo config use staging --output json
```

```json
{
  "schema": "freelo.error/v1",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Profile 'staging' does not exist.",
    "http_status": null,
    "request_id": "...",
    "retryable": false,
    "hint_next": "Run 'freelo auth login --profile staging' to create it, then 'freelo config use staging'.",
    "docs_url": null
  }
}
```

Exit code 2.

## Errors

| Code               | Exit | When                                                |
| ------------------ | ---- | --------------------------------------------------- |
| `VALIDATION_ERROR` | 2    | The named profile does not exist in the conf store. |
| `CONFIG_ERROR`     | 1    | The user conf store is corrupt or unwritable.       |

## See also

- [`freelo config profiles`](./config-profiles.md) — list all profiles and the current one.
- [`freelo config set`](./config-set.md) — `config set profile <name>` is an alias for this command (different envelope shape).
- [`freelo auth login`](./auth-login.md) — create a new profile.
- [`freelo auth whoami`](./auth-whoami.md) — verify the active profile's credentials after switching.
- [Getting started](../getting-started.md)
