# freelo auth logout

Remove stored credentials for a Freelo profile. The operation is local-only — no API call is made and no network access is required. It is idempotent: running it on a profile that has no stored credentials exits 0 and reports `"removed": false`.

## Synopsis

```bash
freelo auth logout [--profile <name>]
```

## Options

| Flag                  | Description                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `--profile <name>`    | Profile to remove credentials from. Inherited global flag; default `default`.                    |
| `--output <mode>`     | `auto` (default), `human`, `json`, `ndjson`. `auto` resolves to `json` when stdout is not a TTY. |
| `--color <mode>`      | `auto` (default), `never`, `always`.                                                             |
| `-v`                  | Increase log verbosity. Pass twice (`-v -v`) for debug level.                                    |
| `--request-id <uuid>` | Override the auto-generated request ID.                                                          |

## Behavior

- Removes the token from both the OS keychain (keytar) and the `tokens.json` fallback file. Both deletions are attempted; "not found" errors from either store are silently ignored.
- Removes `profiles[name]` from the conf store. If the removed profile was `currentProfile`, that field is cleared.
- Never prompts. Never calls the Freelo API.

## Output

### Agent invocation (non-TTY)

```bash
freelo auth logout --profile ci
```

```json
{
  "schema": "freelo.auth.logout/v1",
  "data": { "profile": "ci", "removed": true },
  "request_id": "3f4a5b6c-7d8e-9f0a-bcde-f12345678901"
}
```

### Human invocation (TTY)

```bash
freelo auth logout
```

```
Logged out profile 'default'.
```

### Idempotent no-op

```bash
freelo auth logout --profile nonexistent
```

```json
{
  "schema": "freelo.auth.logout/v1",
  "data": { "profile": "nonexistent", "removed": false },
  "request_id": "1a2b3c4d-5e6f-7890-abcd-ef0123456789"
}
```

Exit code is 0 in both the removal and no-op cases.

## Exit codes

| Code | Meaning                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| 0    | Success — credentials removed, or profile was already absent.                                                |
| 1    | Config error — the credential store is corrupt or unwritable in a way that prevents even a deletion attempt. |

## Errors

| Code           | When                                                                | Hint                                                                     |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `CONFIG_ERROR` | Both keytar and the fallback file returned a non-"not-found" error. | Check file permissions on the tokens file; path is in the error message. |

## See also

- [`freelo auth login`](./auth-login.md) — store credentials for a profile.
- [`freelo auth whoami`](./auth-whoami.md) — verify which account is currently active.
- [Getting started](../getting-started.md)
