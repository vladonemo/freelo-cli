# freelo auth login

Store credentials for a Freelo profile and verify them. Calls `GET /users/me` before persisting anything — credentials are never saved when verification fails. Agents use env vars and skip all prompts; humans get an interactive prompt on a TTY.

## Synopsis

```bash
freelo auth login [--email <address>] [--api-key-stdin] [--profile <name>]
```

## Options

| Flag                  | Description                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--email <address>`   | Freelo account email. Required in `--api-key-stdin` mode. Optional otherwise — omitting it in interactive mode triggers an email prompt.                 |
| `--api-key-stdin`     | Read the API key from stdin until EOF; trims a single trailing newline. Requires `--email`. The key never appears in process arguments or shell history. |
| `--profile <name>`    | Profile to write credentials into. Inherited global flag; default `default`.                                                                             |
| `--output <mode>`     | `auto` (default), `human`, `json`, `ndjson`. `auto` resolves to `json` when stdout is not a TTY.                                                         |
| `--color <mode>`      | `auto` (default), `never`, `always`.                                                                                                                     |
| `-v`                  | Increase log verbosity. Pass twice (`-v -v`) for debug level.                                                                                            |
| `--request-id <uuid>` | Override the auto-generated request ID.                                                                                                                  |

## Credential resolution

The command resolves credentials from the first available source:

1. `--api-key-stdin` — reads the key from stdin. Requires `--email`.
2. `FREELO_API_KEY` + `FREELO_EMAIL` env vars (both must be set; one alone falls through).
3. OS keychain via keytar. Set `FREELO_NO_KEYCHAIN=1` to skip keytar entirely and use the file fallback.
4. `conf`-backed fallback file — checked only to detect an existing profile for the overwrite notice; the token is not read from here on this path.

If none of these sources are available and stdin is not a TTY, the command fails with `AUTH_MISSING` (exit 3). It never hangs waiting on a closed stdin.

When both `--email` and `FREELO_EMAIL` are set, they must match; a mismatch is a `VALIDATION_ERROR` (exit 2).

## Overwrite behavior

If the named profile already exists, the command silently overwrites it. The envelope includes `"replaced": true` and an optional `notice` field. No `--force` flag is required in R01.

## Output

### Agent invocation (env vars, non-TTY)

```bash
FREELO_EMAIL=agent@acme.cz FREELO_API_KEY=sk-... freelo auth login --profile ci
```

```json
{
  "schema": "freelo.auth.login/v1",
  "data": { "profile": "ci", "email": "agent@acme.cz", "user_id": 12345, "replaced": false },
  "rate_limit": { "remaining": null, "reset_at": null },
  "request_id": "8b2a1c3d-4e5f-6789-abcd-ef0123456789"
}
```

Output is a single `\n`-terminated line. The `rate_limit` field is included when the command makes an HTTP call. `request_id` is included when one was generated or supplied.

### Human invocation (TTY)

```bash
freelo auth login
```

```
? Freelo account email: jane@acme.cz
? Freelo API token: ********************************
Logged in as jane@acme.cz on profile 'default'.
```

### stdin key (agent, pipe)

```bash
echo "sk-..." | freelo auth login --email agent@acme.cz --profile ci
```

Reads until EOF; the trailing newline is stripped automatically.

## Exit codes

| Code | Meaning                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------- |
| 0    | Credentials stored and verified.                                                                                     |
| 2    | Validation error — bad email format, `--api-key-stdin` without `--email`, mismatched `--email` / `FREELO_EMAIL`.     |
| 3    | Auth error — no credential source in non-interactive mode (`AUTH_MISSING`), or Freelo returned 401 (`AUTH_EXPIRED`). |
| 4    | Freelo API error — non-401 HTTP error or unexpected response shape.                                                  |
| 5    | Network error — DNS failure, connection refused, timeout.                                                            |
| 6    | Rate limited — 429 after retry budget exhausted.                                                                     |
| 130  | SIGINT — Ctrl-C mid-prompt or mid-request.                                                                           |

## Errors

| Code               | When                                                                                              | Hint                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `AUTH_MISSING`     | Non-interactive mode with no credential source.                                                   | Set `FREELO_API_KEY` and `FREELO_EMAIL`, or pass `--api-key-stdin`. |
| `AUTH_EXPIRED`     | Freelo returned 401 (credentials rejected).                                                       | Verify the API key in your Freelo account settings.                 |
| `FREELO_API_ERROR` | Non-401 HTTP error from Freelo, or response failed schema validation.                             | Check the `http_status` field in the error envelope.                |
| `VALIDATION_ERROR` | Bad email format, missing `--email` with `--api-key-stdin`, or `--email`/`FREELO_EMAIL` mismatch. | Correct the flagged field.                                          |
| `NETWORK_ERROR`    | Connection or DNS failure.                                                                        | Check network connectivity.                                         |
| `RATE_LIMITED`     | 429 after three attempts.                                                                         | Wait and retry; inspect `hint_next` for a delay.                    |
| `CONFIG_ERROR`     | Profile store is corrupt, or both keytar and the fallback file are unwritable.                    | Check the path in the error message.                                |

## See also

- [`freelo auth whoami`](./auth-whoami.md) — verify stored credentials without re-entering them.
- [`freelo auth logout`](./auth-logout.md) — remove stored credentials for a profile.
- [Getting started](../getting-started.md)
