# Getting started

## Install

```bash
npm install -g freelo-cli
```

Requires Node.js 20.11 LTS or newer.

## Designed for agents first, humans second

The CLI defaults to JSON output when stdout is not a TTY — no `--output json` flag needed. Every response is a versioned envelope (`schema`, `data`, `rate_limit`, `request_id`) so scripts can parse output and branch on errors without guessing at format.

## First run: agents

Set `FREELO_API_KEY` and `FREELO_EMAIL` in the environment. The API key is available in your Freelo account settings under **Profile → Settings → API**.

```bash
export FREELO_EMAIL=agent@acme.cz
export FREELO_API_KEY=sk-...
freelo auth whoami
```

```json
{
  "schema": "freelo.auth.whoami/v1",
  "data": {
    "profile": "default",
    "profile_source": "env",
    "user_id": 12345,
    "email": "agent@acme.cz",
    "api_base_url": "https://api.freelo.io/v1"
  },
  "rate_limit": { "remaining": 97, "reset_at": null },
  "request_id": "7e6f0c3e-2a3b-4c1d-8e9f-0a1b2c3d4e5f"
}
```

Exit 0 means the credentials are valid. From here every subsequent command picks up the same env vars — no login step required.

## First run: humans

On a TTY, run `freelo auth login`. The command prompts for your email and API key, verifies them against the Freelo API, and stores the credentials in your OS keychain (or a `0600` fallback file on systems without one).

```bash
freelo auth login
```

```
? Freelo account email: jane@acme.cz
? Freelo API token: ********************************
Logged in as jane@acme.cz on profile 'default'.
```

Verify the stored credentials:

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

## Auth reference

- [`freelo auth login`](./commands/auth-login.md) — store and verify credentials.
- [`freelo auth logout`](./commands/auth-logout.md) — remove stored credentials.
- [`freelo auth whoami`](./commands/auth-whoami.md) — check the active account.

## Next steps

See [`docs/roadmap.md`](./roadmap.md) for the full incremental delivery plan.
