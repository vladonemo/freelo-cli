# freelo config unset

Remove a stored value from the user conf store, reverting the key to its default.

## Synopsis

```bash
freelo config unset <key>
```

## What it does

Deletes the stored value for `<key>` from the user conf store. After this call, the key resolves from a lower precedence layer (rc file, then default). No network call is made.

The operation is idempotent: if the key was not set in the conf store, the command exits 0 with `removed: false`.

`apiBaseUrl` cannot be truly deleted because it is a required field of the profile record. Unsetting it resets it to the default value (`https://api.freelo.io/v1`) rather than removing the field.

Read-only keys (`email`, `apiKey`, etc.) cannot be unset via `config unset`. To remove credentials use `freelo auth logout`.

## Options

This command has no subcommand-specific flags. See [Getting started](../getting-started.md) for global flags (`--output`, `--profile`, `--color`, `-v`, `--request-id`).

## Examples

### Human invocation (TTY)

```bash
freelo config unset output
```

```
output: removed (was 'json') (defaults).
```

### Agent invocation (non-TTY, JSON output)

```bash
freelo config unset output --output json
```

```json
{
  "schema": "freelo.config.unset/v1",
  "data": {
    "key": "output",
    "previous_value": "json",
    "removed": true,
    "scope": "defaults",
    "profile": null
  },
  "request_id": "5d6e7f8a-9b0c-1d2e-3f45-6789abcdef01"
}
```

### Idempotent no-op (key was not set)

```bash
freelo config unset output --output json
```

```json
{
  "schema": "freelo.config.unset/v1",
  "data": {
    "key": "output",
    "previous_value": null,
    "removed": false,
    "scope": "defaults",
    "profile": null
  },
  "request_id": "6e7f8a9b-0c1d-2e3f-4567-89abcdef0123"
}
```

Exit code 0 in both cases.

### Reset a per-profile API base URL

```bash
freelo config unset apiBaseUrl --profile ci --output json
```

```json
{
  "schema": "freelo.config.unset/v1",
  "data": {
    "key": "apiBaseUrl",
    "previous_value": "https://staging.api.freelo.io/v1",
    "removed": true,
    "scope": "profile",
    "profile": "ci"
  },
  "request_id": "7f8a9b0c-1d2e-3f45-6789-abcdef012345"
}
```

## Errors

| Code               | Exit | When                                                    |
| ------------------ | ---- | ------------------------------------------------------- |
| `VALIDATION_ERROR` | 2    | Unknown key or read-only key (`email`, `apiKey`, etc.). |
| `AUTH_MISSING`     | 3    | `apiBaseUrl` key with no active profile.                |
| `CONFIG_ERROR`     | 1    | The user conf store is corrupt or unwritable.           |

## See also

- [`freelo config set`](./config-set.md) — write a value.
- [`freelo config get`](./config-get.md) — read the current value before unsetting.
- [`freelo auth logout`](./auth-logout.md) — remove stored credentials.
- [Getting started](../getting-started.md)
