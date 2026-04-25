# freelo auth whoami

Show the currently authenticated user. Resolves credentials from the environment or stored profile, calls `GET /users/me`, and returns a typed envelope. This is the canonical "am I authenticated?" check for both agents and humans.

## Synopsis

```bash
freelo auth whoami [--profile <name>]
```

## Options

| Flag                  | Description                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `--profile <name>`    | Profile to resolve credentials from. Inherited global flag; default `default`.                   |
| `--output <mode>`     | `auto` (default), `human`, `json`, `ndjson`. `auto` resolves to `json` when stdout is not a TTY. |
| `--color <mode>`      | `auto` (default), `never`, `always`.                                                             |
| `-v`                  | Increase log verbosity. Pass twice (`-v -v`) for debug level.                                    |
| `--request-id <uuid>` | Override the auto-generated request ID.                                                          |

## Credential resolution

Credentials are resolved from the first available source:

1. `FREELO_API_KEY` + `FREELO_EMAIL` env vars (both must be set; one alone falls through).
2. OS keychain via keytar. Set `FREELO_NO_KEYCHAIN=1` to skip keytar and use the file fallback.
3. `conf`-backed fallback file (`tokens.json`).

The resolved source is reported in the envelope as `profile_source`:

| `profile_source` | Meaning                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `env`            | Credentials came from `FREELO_API_KEY` / `FREELO_EMAIL` env vars (or `--api-key-stdin`, though that is not a `whoami` flow). |
| `conf`           | Credentials came from the stored profile (keytar or fallback file).                                                          |

If no source is available, the command fails with `AUTH_MISSING` (exit 3).

## Output

### Agent invocation (env vars, non-TTY)

```bash
FREELO_EMAIL=agent@acme.cz FREELO_API_KEY=sk-... freelo auth whoami
```

```json
{
  "schema": "freelo.auth.whoami/v1",
  "data": {
    "profile": "default",
    "profile_source": "env",
    "user_id": 12345,
    "email": "agent@acme.cz",
    "full_name": "Jane Doe",
    "api_base_url": "https://api.freelo.io/v1"
  },
  "rate_limit": { "remaining": 97, "reset_at": null },
  "request_id": "7e6f0c3e-2a3b-4c1d-8e9f-0a1b2c3d4e5f"
}
```

`full_name` is omitted when the Freelo API does not return it. `rate_limit` is always present because the command makes an HTTP call.

### Human invocation (TTY)

```bash
freelo auth whoami
```

```
Profile:     default (source: conf)
User:        Jane Doe
User ID:     12345
Email:       jane@acme.cz
API base:    https://api.freelo.io/v1
```

### Checking a named profile

```bash
freelo auth whoami --profile ci
```

Both the env-var and the stored-profile paths work with `--profile`. When `FREELO_API_KEY` + `FREELO_EMAIL` are set they take precedence over any stored profile regardless of the `--profile` value.

## Exit codes

| Code | Meaning                                                                                      |
| ---- | -------------------------------------------------------------------------------------------- |
| 0    | Success — authenticated user returned.                                                       |
| 3    | Auth error — no credentials found (`AUTH_MISSING`), or Freelo returned 401 (`AUTH_EXPIRED`). |
| 4    | Freelo API error — non-401 HTTP error or unexpected response shape.                          |
| 5    | Network error — DNS failure, connection refused, timeout.                                    |
| 6    | Rate limited — 429 after retry budget exhausted.                                             |
| 130  | SIGINT — Ctrl-C mid-request.                                                                 |

## Errors

| Code               | When                                                                  | Hint                                                              |
| ------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `AUTH_MISSING`     | No credential source found for the profile.                           | Run `freelo auth login` or set `FREELO_API_KEY` + `FREELO_EMAIL`. |
| `AUTH_EXPIRED`     | Freelo returned 401 (stored token is no longer valid).                | Run `freelo auth login` to refresh the stored token.              |
| `FREELO_API_ERROR` | Non-401 HTTP error from Freelo, or response failed schema validation. | Check the `http_status` field in the error envelope.              |
| `NETWORK_ERROR`    | Connection or DNS failure.                                            | Check network connectivity.                                       |
| `RATE_LIMITED`     | 429 after three attempts.                                             | Wait and retry; inspect `hint_next` for a delay.                  |

## See also

- [`freelo auth login`](./auth-login.md) — store and verify credentials for a profile.
- [`freelo auth logout`](./auth-logout.md) — remove stored credentials for a profile.
- [Getting started](../getting-started.md)
