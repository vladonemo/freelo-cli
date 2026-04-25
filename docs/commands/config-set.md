# freelo config set

Write a value to the user conf store for a writable configuration key.

## Synopsis

```bash
freelo config set <key> <value>
```

## What it does

Validates `<value>` against the per-key schema, then persists it to the user conf store. No network call is made. The operation is idempotent: writing the value already in place succeeds with `previous_value === value`.

### Writable keys

| Key          | Accepted values                   | Where it is stored           |
| ------------ | --------------------------------- | ---------------------------- |
| `output`     | `auto`, `human`, `json`, `ndjson` | global `defaults`            |
| `color`      | `auto`, `never`, `always`         | global `defaults`            |
| `verbose`    | `0`, `1`, `2`                     | global `defaults`            |
| `apiBaseUrl` | any valid URL                     | active profile in `profiles` |
| `profile`    | any existing profile name         | `currentProfile` (global)    |

### Scope asymmetry

`output`, `color`, and `verbose` are machine-wide preferences and go into the global `defaults` map (`scope: "defaults"` in the envelope). They apply regardless of which profile is active.

`apiBaseUrl` is per-profile — different profiles may point at different Freelo endpoints (for example, a staging environment). `config set apiBaseUrl` writes to the **currently active profile**. If no profile is active yet, the command fails with `AUTH_MISSING` (exit 3). Run `freelo auth login` first.

`profile` switches the active profile, the same as running `freelo config use <name>`. The target profile must already exist.

### Read-only keys

`email`, `apiKey`, `requestId`, `yes`, `userAgent`, and `profileSource` cannot be set via `config set`. Attempting to do so returns `VALIDATION_ERROR` (exit 2). Update credentials with `freelo auth login`.

## Options

This command has no subcommand-specific flags. See [Getting started](../getting-started.md) for global flags (`--output`, `--profile`, `--color`, `-v`, `--request-id`).

## Examples

### Set the default output format (human)

```bash
freelo config set output json
```

```
output: 'auto' -> 'json' (defaults).
```

### Set a per-profile API base URL (agent, non-TTY)

You need an active profile first. Run `freelo auth login` if you have not already.

```bash
freelo config set apiBaseUrl https://staging.api.freelo.io/v1 --output json
```

```json
{
  "schema": "freelo.config.set/v1",
  "data": {
    "key": "apiBaseUrl",
    "previous_value": "https://api.freelo.io/v1",
    "value": "https://staging.api.freelo.io/v1",
    "scope": "profile",
    "profile": "default"
  },
  "request_id": "8b2a1c3d-4e5f-6789-abcd-ef0123456789"
}
```

### Idempotent write (value already set)

```bash
freelo config set output json --output json
```

```json
{
  "schema": "freelo.config.set/v1",
  "data": {
    "key": "output",
    "previous_value": "json",
    "value": "json",
    "scope": "defaults",
    "profile": null
  },
  "request_id": "4c5d6e7f-8a9b-0c1d-2e3f-456789abcdef"
}
```

### Error: unknown key

```bash
freelo config set fooBar 1 --output json
```

```json
{
  "schema": "freelo.error/v1",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Unknown config key 'fooBar'. Run 'freelo config list' for the catalog of writable keys.",
    "http_status": null,
    "request_id": "...",
    "retryable": false,
    "hint_next": "Run 'freelo config list' for the catalog of writable keys.",
    "docs_url": null
  }
}
```

Exit code 2.

### Error: read-only key

```bash
freelo config set apiKey sk-... --output json
```

```json
{
  "schema": "freelo.error/v1",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Config key 'apiKey' is read-only. Use 'freelo auth login' to update credentials.",
    "http_status": null,
    "request_id": "...",
    "retryable": false,
    "hint_next": "Run 'freelo auth login' to update credentials.",
    "docs_url": null
  }
}
```

Exit code 2.

## Errors

| Code               | Exit | When                                                                                         |
| ------------------ | ---- | -------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR` | 2    | Unknown key, read-only key, or value that fails the per-key schema (e.g. bad URL, bad enum). |
| `VALIDATION_ERROR` | 2    | `profile` key: the target profile does not exist in the conf store.                          |
| `AUTH_MISSING`     | 3    | `apiBaseUrl` key with no active profile (no `freelo auth login` yet).                        |
| `CONFIG_ERROR`     | 1    | The user conf store is corrupt or unwritable.                                                |

## See also

- [`freelo config unset`](./config-unset.md) — remove a stored value and fall back to the default.
- [`freelo config get`](./config-get.md) — read a key without writing.
- [`freelo config use`](./config-use.md) — preferred form for switching the active profile.
- [`freelo auth login`](./auth-login.md) — set credentials (`email`, `apiKey`).
- [Getting started](../getting-started.md)
