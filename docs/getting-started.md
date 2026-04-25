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

## Project-level config (`.freelorc`)

Drop a `.freelorc` file at the root of a repository to set per-project defaults. The CLI discovers it automatically by walking up from the current directory — no flag required.

Supported filenames, in discovery order:

1. `.freelorc` (JSON content)
2. `.freelorc.json`
3. `.freelorc.yaml`
4. `.freelorc.yml`

JS and TypeScript config files (`freelo.config.js`, `.mjs`, `.ts`) are deliberately not loaded. Loading user code on every CLI invocation is a security surface the CLI does not take on.

**JSON example** — pin a project to the `ci` profile and use NDJSON output:

```json
{ "profile": "ci", "output": "ndjson" }
```

**YAML example** — set verbosity for a noisy debugging session:

```yaml
output: json
verbose: 1
```

The rc file accepts: `output`, `color`, `profile`, `apiBaseUrl`, `verbose`. Unknown keys are rejected with a `CONFIG_ERROR` (exit 2). Credentials (`apiKey`, `email`) are rejected by design — store those with `freelo auth login`.

**Precedence** (highest to lowest): flag > env > rc > conf > default.

The rc layer sits between environment variables and the user conf store. An environment variable always wins over the rc file; a value in the rc file wins over anything stored via `freelo config set`.

## Debugging config drift with `freelo config resolve`

When a CLI invocation behaves unexpectedly, `freelo config resolve --show-source` shows the merged effective configuration with the source of every leaf:

```bash
freelo config resolve --show-source --output json
```

```json
{
  "schema": "freelo.config.resolve/v1",
  "data": {
    "profile": { "value": "ci", "source": "env" },
    "profileSource": { "value": "env", "source": "derived" },
    "email": { "value": "agent@acme.cz", "source": "conf" },
    "apiKey": { "value": "[redacted]", "source": "conf" },
    "has_token": { "value": true, "source": "derived" },
    "apiBaseUrl": { "value": "https://api.freelo.io/v1", "source": "default" },
    "output": {
      "mode": { "value": "json", "source": "rc" },
      "color": { "value": "auto", "source": "default" }
    },
    "verbose": { "value": 0, "source": "default" },
    "yes": { "value": false, "source": "default" },
    "requestId": { "value": "...", "source": "flag" }
  },
  "request_id": "..."
}
```

`source: "rc"` on `output.mode` tells you a `.freelorc.*` file is overriding the stored default. `has_token: false` means the active profile has no stored token — run `freelo auth login` to restore it. This check requires no network call.

## Config reference

- [`freelo config list`](./commands/config-list.md) — all keys with values and sources.
- [`freelo config get`](./commands/config-get.md) — read a single key.
- [`freelo config set`](./commands/config-set.md) — write a writable key.
- [`freelo config unset`](./commands/config-unset.md) — revert a key to its default.
- [`freelo config profiles`](./commands/config-profiles.md) — list all profiles.
- [`freelo config use`](./commands/config-use.md) — switch the active profile.
- [`freelo config resolve`](./commands/config-resolve.md) — full merged config with per-leaf source annotation.

## Agent discovery — `freelo --introspect`

Agents and CI scripts that drive the CLI need to know what commands exist, what flags they take, and what envelope schema each one returns. Don't parse `--help` — call **`freelo --introspect`** instead. It walks the live program tree and emits a single `freelo.introspect/v1` envelope with every command, flag, argument, output schema, and `destructive` boolean.

```bash
$ freelo --introspect | jq '.data.commands[].name'
"auth login"
"auth logout"
"auth whoami"
"config get"
"config list"
…
```

The same payload is also reachable via the agent-friendly alias `freelo help --output json` (full) or `freelo help <command> --output json` (scoped).

Use it to:

- Generate tool-use manifests for MCP servers or Claude Code tool registries.
- Diff the surface between CLI versions in your build pipeline.
- Auto-generate per-command argument schemas in your agent harness.

See [`freelo --introspect`](./commands/introspect.md) for the envelope shape and concrete recipes.

## Next steps

See [`docs/roadmap.md`](./roadmap.md) for the full incremental delivery plan.
