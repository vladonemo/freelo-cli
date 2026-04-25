# freelo config resolve

Print the merged effective configuration. The agent's primary tool for debugging config drift.

## Synopsis

```bash
freelo config resolve [--show-source]
```

## What it does

Resolves the full configuration by walking all precedence layers — flag, env, rc file, user conf, default — and emits the merged result. No network call is made. `apiKey` is always `"[redacted]"`; the `has_token` boolean tells you whether a real token is stored for the active profile.

Without `--show-source` the envelope contains the flat merged values. With `--show-source` every leaf becomes `{ "value": ..., "source": "<layer>" }` so you can see exactly which layer won for each setting.

This is the right command to run when a CLI invocation behaves unexpectedly — it surfaces whether a setting came from a `.freelorc` file, an environment variable, or a stored profile default.

## Options

| Flag            | Description                                                                              |
| --------------- | ---------------------------------------------------------------------------------------- |
| `--show-source` | Annotate each config leaf with its source layer: `flag`, `env`, `rc`, `conf`, `default`. |

See [Getting started](../getting-started.md) for global flags (`--output`, `--profile`, `--color`, `-v`, `--request-id`).

## Examples

### Agent: flat merged config (no `--show-source`)

```bash
FREELO_EMAIL=agent@acme.cz FREELO_API_KEY=sk-... freelo config resolve --output json
```

```json
{
  "schema": "freelo.config.resolve/v1",
  "data": {
    "profile": "ci",
    "profileSource": "env",
    "email": "agent@acme.cz",
    "apiKey": "[redacted]",
    "has_token": true,
    "apiBaseUrl": "https://api.freelo.io/v1",
    "userAgent": "freelo-cli/0.x.x (+https://github.com/vladonemo/freelo-cli)",
    "output": { "mode": "json", "color": "auto" },
    "verbose": 0,
    "yes": false,
    "requestId": "8b2a1c3d-4e5f-6789-abcd-ef0123456789"
  },
  "request_id": "8b2a1c3d-4e5f-6789-abcd-ef0123456789"
}
```

`has_token: false` means no token is stored for the active profile. This is the "did I lose my token?" check — no HTTP call required.

### Agent: per-leaf source annotation (`--show-source`)

```bash
FREELO_PROFILE=ci freelo config resolve --show-source --output json
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

`source: "rc"` on `output.mode` means a `.freelorc.*` file in the project tree overrode the stored default. `source: "derived"` is used for fields that are computed from other fields (`profileSource`, `has_token`) and have no source of their own.

Source enum values: `flag` > `env` > `rc` > `conf` > `default`.

### Human invocation (TTY)

```bash
freelo config resolve
```

```
profile:       ci          (source: env)
email:         agent@acme.cz (source: conf)
apiKey:        [redacted]  (source: conf)
has_token:     true
apiBaseUrl:    https://api.freelo.io/v1 (source: default)
output.mode:   json        (source: rc)
output.color:  auto        (source: default)
verbose:       0           (source: default)
```

### Diagnosing a missing token

```bash
freelo config resolve --output json | grep has_token
```

`has_token: false` means the profile exists in the conf store but its token was removed (e.g. by `freelo auth logout`). Run `freelo auth login` to restore it.

## Errors

| Code           | Exit | When                                                                  |
| -------------- | ---- | --------------------------------------------------------------------- |
| `CONFIG_ERROR` | 1    | The user conf store is corrupt or unreadable.                         |
| `CONFIG_ERROR` | 2    | A `.freelorc.*` file in the project tree has unknown or invalid keys. |

## See also

- [`freelo config list`](./config-list.md) — catalog of writable and read-only keys.
- [`freelo config get`](./config-get.md) — look up a single key.
- [`freelo auth whoami`](./auth-whoami.md) — verify credentials with a live API call.
- [Getting started](../getting-started.md) — rc file format and precedence chain.
