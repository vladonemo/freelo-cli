---
"freelo-cli": minor
---

R01: Auth commands + agent-first substrate

Adds `freelo auth login`, `freelo auth logout`, and `freelo auth whoami`
together with the cross-cutting infrastructure every later slice inherits.

**New envelope schemas (public contract):**
- `freelo.auth.login/v1` — result of `freelo auth login`
- `freelo.auth.logout/v1` — result of `freelo auth logout`
- `freelo.auth.whoami/v1` — result of `freelo auth whoami`
- `freelo.error/v1` — structured error envelope on stderr for all failures

**Global flags** now available on every subcommand:
`--output auto|human|json|ndjson`, `--color auto|never|always`,
`--profile <name>`, `-v`/`-vv` verbosity, `--request-id <uuid>`,
`-y`/`--yes`.

**Env-first auth** — `FREELO_API_KEY` + `FREELO_EMAIL` bypass the keychain
entirely. `FREELO_NO_KEYCHAIN=1` forces the fallback file store.

**Agent-first output** — `--output auto` defaults to `json` when stdout is
not a TTY; human renderers and spinners are loaded lazily and never executed
on agent paths.
