# 0002 — Auth + agent-first infra (R01)

**Status:** Accepted — all §7 recommendations adopted 2026-04-24; ready for /plan
**Run:** 2026-04-24-2015-auth-and-agent-first-infra
**Owner:**
**Tier:** Red (broad cross-cutting surface: HTTP client, env-first auth, envelope contract, error taxonomy, global flags, lazy-import policy)

---

## 1. Problem

The scaffold (spec 0001) ships `freelo --version` and nothing else. Before any roadmap slice past R01 can land, the CLI needs an **agent-first substrate**: a typed HTTP client, env-first credentials, a versioned JSON envelope, a structured error envelope, a `--output auto|human|json|ndjson` global flag, a lazy-import discipline for human-UX deps, and a typed error taxonomy. None of these exist today; `src/api/`, `src/config/`, `src/ui/` are empty, `src/errors/` has only `BaseError` + a flat `ConfigError`, and `src/bin/freelo.ts` has a catastrophic-error writer but no typed-error dispatcher.

An earlier draft of this slice (now superseded by this document and scrubbed from `docs/specs/`) scoped only the three auth commands (`login` / `logout` / `whoami`) around a global `--json` boolean and a keychain-first credential chain. It predated the agent-first policy in `.claude/docs/architecture.md`. Shipping that draft as-is would:

- Introduce a `--json` flag we'd immediately rename to `--output json`.
- Default to human output on non-TTY, forcing agents to pass a flag to get structured output.
- Put keychain ahead of env, so an agent with `FREELO_API_KEY` + `FREELO_EMAIL` still pays the `keytar` native-binding cost on cold start.
- Emit ad-hoc JSON payloads with no `schema` field, breaking the stability contract before it starts.
- Top-level-import `@inquirer/prompts`, `ora`, `chalk`, `pino-pretty`, making every agent invocation pay ~tens of MB of RSS and ~100 ms of load time for code it never runs.

R01 therefore bundles **auth + the cross-cutting infra it would otherwise piggy-back on**. Every later slice (R02+) picks up envelope / error / `--output` / lazy-imports / error taxonomy / logging for free; if we split the infra off, every later slice becomes a mini-R01 with a different bias.

Concretely, after R01:

- An agent can run `FREELO_API_KEY=… FREELO_EMAIL=… freelo auth whoami` and get a single-line `freelo.auth.whoami/v1` envelope on stdout with zero prompts, zero keychain reads, and zero human-UX modules loaded.
- A human can run `freelo auth login` on a terminal and get an interactive prompt.
- A failure on either path emits a `freelo.error/v1` envelope on stderr with a stable `code`, an `exitCode`-aligned process exit, and no secrets in the payload.
- R02 (`freelo config`), R02.5 (`--introspect`), and every R03+ read/write command inherit all of this without re-opening it.

## 2. Proposal

### 2.1 Global flags

Registered on the root `Command` in `src/bin/freelo.ts` so every subcommand inherits via `program.optsWithGlobals()`. No subcommand re-declares these.

| Flag | Values | Default | Purpose |
|---|---|---|---|
| `--output <mode>` | `auto` \| `human` \| `json` \| `ndjson` | `auto` | `auto` resolves to `json` when stdout is not a TTY, `human` otherwise. `ndjson` emits one envelope per record (list ops) or per input line (batch writes — R09). |
| `--color <mode>` | `auto` \| `never` \| `always` | `auto` | Honors `NO_COLOR` and `FORCE_COLOR` when `auto`. |
| `--profile <name>` | string | `default` | Credential + config profile. |
| `-v`, `-vv` | — | silent | Verbosity. `-v` → pino `info`, `-vv` → pino `debug`. `FREELO_DEBUG=1` ≡ `-vv`. |
| `--request-id <uuid>` | uuid string | generated (v4) | Passed to server logs (no Freelo header documented yet — captured for our own logs and error envelopes). |
| `--yes`, `-y` | — | false | Bypass destructive-op confirmation. R01 does not ship a destructive op; the flag is registered now so every later slice inherits it. |

**No `--json` shorthand.** `architecture.md` §Global flags forbids it; there is one way to say "give me JSON" and it is `--output json`.

**Per-flag precedence** (highest wins):

| Flag | Precedence chain |
|---|---|
| `--output` | CLI flag > `FREELO_OUTPUT` env > user `conf` > default (`auto`) |
| `--color` | CLI flag > `NO_COLOR` (forces `never`) / `FORCE_COLOR` (forces `always`) > `FREELO_COLOR` env > default (`auto`) |
| `--profile` | CLI flag > `FREELO_PROFILE` env > `conf.currentProfile` > `"default"` |
| `-v` / `-vv` | CLI flag > `FREELO_DEBUG=1` (≡ `-vv`) > default (silent) |
| `--request-id` | CLI flag > generated v4 UUID |
| `--yes` | CLI flag > default (`false`) |

Project-level `.freelorc.*` overrides land in R02 and slot in between `env` and `user conf`. R01 leaves a hole for them (no cosmiconfig dep yet).

### 2.2 `freelo auth login`

**Purpose.** Capture `{ email, apiKey }` for a profile, verify with a `GET /users/me` round-trip, persist on success, exit without side effects on failure.

**Signature.**

```
freelo auth login [--email <e>] [--profile <name>] [--api-key-stdin]
```

No positional args. The API key never appears on the command line (it would leak to `ps` and shell history); it arrives via prompt, env, or stdin.

**Credential-source precedence** (highest wins, first match short-circuits the others):

1. `--api-key-stdin` — CLI reads the key from stdin until EOF, trims a single trailing newline.
2. `FREELO_API_KEY` + `FREELO_EMAIL` env vars (both required — one without the other falls through).
3. OS keychain via `keytar` (service `freelo-cli`, account = profile name). **Skipped entirely** when env is present or `FREELO_NO_KEYCHAIN=1` is set.
4. `conf`-backed fallback file. `login` re-reads to detect an existing profile for the overwrite notice; it does not read the token from here (that's `whoami`'s concern).

**Interactive flow (TTY + no `--api-key-stdin` + no env).**

1. Lazy `await import('@inquirer/prompts')`.
2. If `--email` omitted, `input({ message: 'Freelo account email:' })`. Validation: non-empty, matches `/.+@.+\..+/` (not RFC 5322 — enough to catch typos).
3. `password({ message: 'Freelo API token:', mask: '*' })`. Validation: non-empty after trim.
4. Spin an `ora` spinner "Verifying…" (lazy-imported, human mode only).
5. `GET /users/me` with `Basic base64(email:apiKey)`.
6. On 2xx: `conf` writes `profiles[name] = { email, apiBaseUrl, schemaVersion }`, keytar (or fallback) writes the token, `currentProfile` set if unset. Envelope emitted (see below).
7. On 401: nothing persisted; exit 3 with `AUTH_MISSING`-coded envelope.

**Non-interactive flow (any of: no TTY on stdin; `--api-key-stdin`; env set).**

- No prompts ever. If neither stdin-supplied nor env-supplied, fail closed with `ConfirmationError`-style shape: `code: "AUTH_MISSING"`, exit 3, hint `Set FREELO_API_KEY and FREELO_EMAIL or pass --api-key-stdin.` (This reuses the fail-closed discipline even though `ConfirmationError` is not the thrown class; see §2.8.)
- `--email` is required in `--api-key-stdin` mode (the key alone doesn't carry an email). Missing → `ValidationError`, exit 2.
- In env mode, `FREELO_EMAIL` supplies the email; `--email` if provided must match or else `ValidationError` (exit 2).
- Still calls `/users/me` before persisting. Still persists on 2xx (see Open question on persistence semantics).

**Overwrite policy (R01).** If `profiles[name]` already exists, silently overwrite and emit a one-line `notice: 'replaced token for profile <name>'` field in the envelope (human mode prints `Replaced token for profile '<name>'.`). R13 adds the reusable confirm helper; `--force` is deliberately not introduced here to avoid a flag we'd retire.

**Output.** Every command emits an envelope (§2.13). For `login`:

```
{ "schema": "freelo.auth.login/v1",
  "data": { "profile": "<n>", "email": "<e>", "user_id": 12345, "replaced": false },
  "request_id": "...",
  "rate_limit": { "remaining": 42, "reset_at": null } }
```

**Examples.**

Agent-style (zero-prompt, env + `--output json` explicit for clarity):

```
$ FREELO_EMAIL=agent@acme.cz FREELO_API_KEY=sk-… freelo auth login --profile ci --output json
{"schema":"freelo.auth.login/v1","data":{"profile":"ci","email":"agent@acme.cz","user_id":12345,"replaced":false},"request_id":"8b2a…","rate_limit":{"remaining":null,"reset_at":null}}
$ echo $?
0
```

Human (TTY):

```
$ freelo auth login
? Freelo account email: jane@acme.cz
? Freelo API token: ********************************
Logged in as Jane Doe (jane@acme.cz) on profile 'default'.
```

Error (non-TTY, no env, no stdin):

```
$ freelo auth login < /dev/null
{"schema":"freelo.error/v1","error":{"code":"AUTH_MISSING","message":"Credentials required.","http_status":null,"retryable":false,"hint_next":"Set FREELO_API_KEY and FREELO_EMAIL or pass --api-key-stdin.","request_id":"…"}}
$ echo $?
3
```

**Exit codes.** 0 success · 2 usage (bad `--email`, `--api-key-stdin` without `--email`) · 3 `AUTH_MISSING` (non-TTY without credential source) or `AUTH_EXPIRED` (401) · 4 non-401 `FreeloApiError` · 5 `NetworkError` · 6 `RateLimitedError` (retries exhausted) · 130 SIGINT.

### 2.3 `freelo auth logout`

**Purpose.** Remove a profile's credentials, idempotently.

**Signature.**

```
freelo auth logout [--profile <name>]
```

**Behavior.**

- Delete token from keytar *and* from the fallback `tokens.json` (always attempt both — a profile may have drifted between stores across reinstalls). Errors from an individual store that say "not found" are swallowed.
- Remove `profiles[name]` from `conf`. If `currentProfile === name`, clear it.
- Exit 0 whether or not the profile existed. `data.removed` is `true` when something was deleted, `false` on the idempotent no-op.
- Never prompts. Never calls the API. Does not depend on credentials being valid.

**Output envelope.** `freelo.auth.logout/v1` with `data: { profile: string, removed: boolean }`.

### 2.4 `freelo auth whoami`

**Purpose.** Resolve `{ email, apiKey }` per precedence, call `/users/me`, emit a typed envelope. The only data-returning command this slice.

**Signature.**

```
freelo auth whoami [--profile <name>]
```

No subcommand-specific flags; inherits `--output`, `--color`, `-v`, `--request-id`.

**Meta.** The command file exports

```
export const meta = {
  outputSchema: 'freelo.auth.whoami/v1',
  destructive: false,
} as const;
```

Read by the R02.5 introspector; R01 defines the pattern.

**Behavior.**

1. Resolve credentials per §2.2's precedence. If nothing found, `ConfigError({ kind: 'missing-token' })` → exit 3 (`AUTH_MISSING`).
2. Build an `HttpClient` (§2.5) from `{ email, apiKey, apiBaseUrl, userAgent }`.
3. `GET /users/me` with `AbortSignal` piped from SIGINT.
4. Parse response through `UserMeEnvelopeSchema` (§4). On zod failure, `FreeloApiError` with the raw body.
5. Build a `WhoamiResult` (§4) — `{ profile, user_id, email, full_name?, api_base_url, profile_source }`.
6. Wrap in `freelo.auth.whoami/v1` envelope and dispatch via `render(mode, envelope, renderWhoamiHuman)`.

**Output modes.**

- `human`: labelled rows (profile, user, user id, api base). No ASCII chrome.
- `json`: single envelope, `\n`-terminated.
- `ndjson`: same single envelope, `\n`-terminated. (The point is mode parity — `ndjson` is never rejected. List commands in R03+ emit one envelope per record; single-reads emit one envelope regardless.)
- `auto`: resolved by `src/lib/env.ts::resolveOutputMode` to `json` off-TTY, `human` on-TTY.

**Envelope example.**

```
{ "schema": "freelo.auth.whoami/v1",
  "data": {
    "profile": "default",
    "profile_source": "env",
    "user_id": 12345,
    "email": "jane@acme.cz",
    "full_name": "Jane Doe",
    "api_base_url": "https://api.freelo.io/v1"
  },
  "rate_limit": { "remaining": 97, "reset_at": null },
  "request_id": "7e6f0c3e-2a3b-4c1d-8e9f-0a1b2c3d4e5f" }
```

`full_name` is optional and omitted entirely when the server doesn't return it — see the Real-fixture open question.

### 2.5 HTTP client — `src/api/client.ts`

Single factory: `createHttpClient({ email, apiKey, apiBaseUrl, userAgent, logger }): HttpClient`.

**Transport.** `undici` (global dispatcher is fine for R01; a tuned `Agent` lands with the first concurrent-request surface). `fetch`-compatible request/response types; no leaky undici types escape into callers.

**Basic Auth.** `Authorization: Basic ${base64(`${email}:${apiKey}`)}`. Built by the client from `{email, apiKey}` — callers never see the header.

**Required headers on every request.**

- `Authorization: Basic …` (built by client)
- `User-Agent: freelo-cli/<VERSION> (+https://github.com/vladonemo/freelo-cli)` — VERSION from `src/lib/version.ts`.
- `Accept: application/json`
- `Content-Type: application/json; charset=utf-8` — on writes only (POST/PATCH/PUT/DELETE with a body).
- `X-Request-Id: <uuid>` — our own convention; captured in our logs and error envelopes. Freelo doesn't document a correlation header; this is for local logging + server-log correlation *if* Freelo honors it.

**AbortSignal threading.** Every method takes an `AbortSignal`. `src/bin/freelo.ts` registers a SIGINT handler that aborts a shared `AbortController` before exiting 130.

**429 retry budget.**

- GETs only. Writes throw `RateLimitedError` immediately.
- N = 3 attempts total (initial + 2 retries).
- Sleep = `Retry-After` header value in seconds (if numeric, if HTTP-date then compute delta) else `1000 ms`, plus `jitter(0..500 ms)`.
- Log each retry at `warn` level with `{ attempt, sleepMs, requestId }`.
- Exhaustion → `RateLimitedError` with the last response body attached, exit 6.

**Rate-limit header capture.** The response-wrapper extracts `{ remaining, resetAt }` from any of `RateLimit-Remaining` / `X-RateLimit-Remaining` / `Retry-After` (if present) and attaches it to the `ApiResponse`. When absent, both fields are `null`. The renderer drops this into the envelope's `rate_limit` field.

**Authorization redaction.** The pino request/response logger replaces `Authorization` with the string `"[redacted]"` and scrubs any `email`/`password`/`api_key`/`apiKey` keys from the logged body. Applied centrally in the log serializer so no per-call mistakes are possible.

**Error surface.** 401 → `FreeloApiError` with `code: 'AUTH_EXPIRED'` (exit 3). 4xx (non-401) → `FreeloApiError` with `code: 'FREELO_API_ERROR'` (exit 4). 5xx → same (`retryable: true`, still exit 4). 429 after budget → `RateLimitedError` (exit 6). Undici connection / DNS / timeout / abort → `NetworkError` (exit 5). Zod parse failure on 2xx → `FreeloApiError` with the raw body attached and `code: 'FREELO_API_ERROR'` (exit 4) — clearly malformed server response.

### 2.6 Credentials + non-secret config — `src/config/`

Two physically separate stores, one logical `AppConfig`.

**Non-secret store — `conf`.**

- File at `<platform-conf-path>/freelo-cli/config.json` (conf picks per-OS path).
- Schema (§4): `{ schemaVersion: 1, currentProfile: string | null, profiles: Record<string, { email: string, apiBaseUrl: string }> }`.
- No tokens here. `schemaVersion` ships as `1` from day one; migration runner deferred (see Open question).

**Secret store — `keytar` with file fallback.**

- `keytar`: service `freelo-cli`, account = profile name, password = apiKey.
- On keytar import/load failure (headless Linux without libsecret, Docker, Alpine, broken native binding), fall back to sibling file `<confDir>/tokens.json` at `0600`, shape `{ "<profile>": "<apiKey>" }`.
- One-shot warning to stderr on first fallback activation per process: `warning: OS keychain unavailable; storing token in <path> (0600). Install libsecret for better security.`. Suppressed in `json`/`ndjson` modes (warnings corrupt structured output — log at pino `warn` instead, surfaced only with `-v`).
- `FREELO_NO_KEYCHAIN=1` forces the file fallback regardless of keytar availability. Useful for CI and agents that don't want to pay the keytar import cost.

**Precedence (credentials).** Same as §2.2: `--api-key-stdin` > env > keytar > conf-fallback file.

**`buildAppConfig`.** Called exactly once at startup by `src/bin/freelo.ts`. Emits a frozen `AppConfig` object. Commands never read `process.env` or the store directly — they receive `AppConfig` via the action-handler closure.

**Env-only mode.** When `FREELO_API_KEY` + `FREELO_EMAIL` are set and the operator never ran `login`, every command works stateless. `whoami` reports `profile_source: 'env'`. `conf` is not touched.

**Corrupt store.** A `conf` file that fails the zod parse throws `ConfigError({ kind: 'corrupt-config' })` with a hint pointing at the file path. Exit 1. No automatic repair; the user deletes the file or runs `login` to re-create it (`login` overwrites the malformed entry silently this slice).

### 2.7 Envelope contract — `src/ui/envelope.ts`

**Shape.**

```ts
type Envelope<T> = {
  schema: `freelo.${string}/v${number}`;
  data: T;
  paging?: { page: number; per_page: number; total: number; next_cursor: number | null };
  rate_limit?: { remaining: number | null; reset_at: string | null };
  request_id?: string;
  dry_run?: true;
  would?: unknown;
};
```

Rules:

- `schema` is mandatory on every envelope.
- `paging` omitted when inapplicable (non-list, `--output` not `ndjson` for streaming).
- `rate_limit` attached whenever the envelope originates from an HTTP call; `{ remaining: null, reset_at: null }` when no headers were present. Omitted entirely for non-HTTP commands (`logout` when the profile was local-only, `config *` commands in R02).
- `request_id` attached when an HTTP call happened. Also included in error envelopes.
- `dry_run` + `would` appear only under `--dry-run` on write commands (R09+).
- Single-object reads (`whoami`) put the object at `data`, not wrapped in an array.

**Schema-string format.** `freelo.<resource>.<op>/v<n>`. Resource = top-level command, op = subcommand. Examples registered in R01: `freelo.auth.login/v1`, `freelo.auth.logout/v1`, `freelo.auth.whoami/v1`, `freelo.error/v1`.

**Render dispatch.** `render(mode, envelope, humanRenderer)`:

- `json` → `process.stdout.write(JSON.stringify(envelope) + '\n')`.
- `ndjson` → same as `json` for single-object outputs; list commands in R03+ iterate and write one line per record.
- `human` → call `humanRenderer(envelope.data)`, write to stdout. Spinners/colors only here.
- `auto` → resolve via `src/lib/env.ts::resolveOutputMode(flag)` once, treat as `json` or `human`.

**Stability.** Per `.claude/CLAUDE.md`: additions = minor, removals/renames/retypes = breaking. Envelope schema changes require an explicit changeset line.

### 2.8 Error taxonomy — `src/errors/`

**Classes** (all extend existing `BaseError`):

| Class | `code` values | `exitCode` | `retryable` | Notes |
|---|---|---|---|---|
| `FreeloApiError` | `AUTH_EXPIRED` (401), `FREELO_API_ERROR` (other 4xx/5xx), `VALIDATION_ERROR` (zod fail on 2xx body) | 3 for 401, 4 otherwise | `true` for 5xx, `false` for 4xx except 401 which is handled as auth | Carries `httpStatus`, `requestId`, `errors: string[]` (from body), `rawBody` (scrubbed). |
| `ConfigError` | Discriminated on `kind` — see below. | 1 for `corrupt-config` and `keychain-unavailable`, 3 for `missing-token` and `missing-profile` | `false` | **This class is edited, not added.** Existing file `src/errors/config-error.ts` currently has flat `exitCode = 1`; R01 reshapes it. |
| `ValidationError` | `VALIDATION_ERROR` | 2 | `false` | Bad CLI input (bad email format, unknown subcommand, conflicting flags). Carries `field?` + `value?`. |
| `NetworkError` | `NETWORK_ERROR` | 5 | `true` | Undici connection / DNS / timeout failure. Carries the cause. |
| `ConfirmationError` | `CONFIRMATION_REQUIRED` | 2 | `false` | Destructive op in non-TTY without `--yes`. R01 does **not** throw this (no destructive op); class is defined now so R13 doesn't have to add it. |
| `RateLimitedError` | `RATE_LIMITED` | 6 | `true` | Writes on 429, or GET after N=3 retries. Carries `retryAfterSec` when known. |

**`ConfigError` kinds** (discriminated union, type-level):

```ts
type ConfigErrorKind =
  | { kind: 'missing-token'; profile: string }      // exit 3
  | { kind: 'missing-profile'; profile: string }    // exit 3
  | { kind: 'keychain-unavailable'; path: string }  // exit 1 — we recover via fallback; this is only thrown when the fallback also fails
  | { kind: 'corrupt-config'; path: string };       // exit 1
```

Exit-code mapping lives in the class, not in `handleTopLevelError`, so a reader of the error site can tell what happens. The `keychain-unavailable` → exit 1 choice is flagged in Open questions (it's reachable only when the *fallback* also fails, which means the operator has no way to persist; arguably still a config problem, not an auth problem).

**Error codes (the catalog).** Per `.claude/docs/conventions.md`:

```
AUTH_EXPIRED            (401 or stored-but-rejected)
AUTH_MISSING            (no credentials resolved)
FREELO_API_ERROR        (4xx/5xx that isn't auth)
CONFIRMATION_REQUIRED   (reserved; R13 first use)
VALIDATION_ERROR        (bad CLI input or zod fail on 2xx)
NETWORK_ERROR           (undici failure)
RATE_LIMITED            (429 after budget, or on writes)
CONFIG_ERROR            (generic fallback for the ConfigError kinds without a more specific code)
INTERNAL_ERROR          (bootstrap-path catastrophic, already in src/bin/freelo.ts)
```

**Top-level handler — `src/errors/handle.ts`.** Export

```ts
function handleTopLevelError(err: unknown, mode: 'human' | 'json' | 'ndjson'): never;
```

Behavior:

- Not a `BaseError` subclass → wrap as a synthetic `INTERNAL_ERROR`, exit 1.
- `human` mode: print `message` + `hintNext` to stderr (no stack unless `FREELO_DEBUG=1` / `-vv`), then `process.exit(exitCode)`.
- `json` / `ndjson` mode: emit `freelo.error/v1` envelope to stderr:

```jsonc
{ "schema": "freelo.error/v1",
  "error": {
    "code": "AUTH_EXPIRED",
    "message": "Stored token for profile 'default' is no longer valid.",
    "errors": ["Invalid token"],
    "http_status": 401,
    "request_id": "…",
    "retryable": false,
    "hint_next": "Run `freelo auth login` to refresh.",
    "docs_url": null
  } }
```

- Always redacts Authorization-like fields before emission.

**Relationship to the existing `writeCatastrophicError`.** The catastrophic writer in `src/bin/freelo.ts` handles the case where an error is thrown *before* `mode` is resolved (e.g. argv parsing throws). It stays. `handleTopLevelError` handles every post-resolve error.

### 2.9 Exit codes

| Code | Meaning | Examples |
|---|---|---|
| 0 | Success, including idempotent no-op. | `logout` on an already-gone profile; successful `whoami`. |
| 1 | Generic failure. | `ConfigError({ kind: 'corrupt-config' })`; `INTERNAL_ERROR`. |
| 2 | Usage / validation / `CONFIRMATION_REQUIRED`. | Bad email format; `--api-key-stdin` without `--email`; destructive-op in non-TTY without `--yes` (R13+). |
| 3 | Auth error (missing / expired credentials). | No credential source; 401 from any API call; `AUTH_MISSING`. |
| 4 | Freelo API error (4xx/5xx other than 401). | 403, 404, 500; zod parse failure on 2xx. |
| 5 | Network error. | DNS failure, connection refused, request timeout. |
| 6 | Rate-limited after budget exhausted. | 429 on GET after N=3 retries; 429 on any write (no retry on writes). |
| 130 | SIGINT. | Ctrl-C mid-prompt or mid-request. |

`docs/roadmap.md:57` in the R01 bullet already says `6 = rate-limited`. An earlier table elsewhere in the roadmap said `5 = rate-limited`; `architecture.md` §Exit codes canonicalizes 6. R01 uses 6 and updates any lagging text in the same PR. Flagged in Open questions only if a conflict remains once the PR author reads both files side-by-side.

### 2.10 Logging — `src/lib/logger.ts`

- `pino` logger, default level `silent`, target `process.stderr`.
- `-v` → `info`, `-vv` or `FREELO_DEBUG=1` → `debug`. Level set once, before the first API call, in `src/bin/freelo.ts`.
- Stderr only. Stdout is reserved for structured output.
- `pino-pretty` loaded lazily via `await import('pino-pretty')` and attached *only* when `isInteractive()` and `output === 'human'`. In `json` / `ndjson` / non-TTY paths, pino emits its native JSON lines (still on stderr — agents can ignore or scoop them).
- Serializer redacts `authorization`, `email`, `password`, `api_key`, `apiKey`, `token` keys.
- Every pino line carries `{ request_id, profile }` when available.

### 2.11 Lazy-import policy

**Must** use `await import('…')` behind an `isInteractive()` (or `wantsColor()`) check:

- `@inquirer/prompts` — only `login` in TTY mode.
- `ora` — spinner for `login`'s `/users/me` call; suppressed in non-TTY.
- `boxen`, `cli-table3` — not used in R01; rule still registered.
- `chalk` — used only by `human`-mode renderers.
- `pino-pretty` — per §2.10.
- `update-notifier` — not used in R01; rule registered for R50+.

**Enforced** by an `eslint.config.js` rule: `no-restricted-imports` with a custom message pointing at `src/lib/env.ts::isInteractive`. Violations are a lint error, fail CI.

### 2.12 TTY detection — `src/lib/env.ts`

The one place that reads `process.stdout.isTTY`, `process.stdin.isTTY`, `NO_COLOR`, `FORCE_COLOR`, `CI`. Exports:

```ts
function isInteractive(): boolean;                                  // both stdin & stdout TTY, and !CI
function wantsColor(flag: 'auto' | 'never' | 'always'): boolean;    // honors NO_COLOR, FORCE_COLOR
function resolveOutputMode(flag: 'auto' | 'human' | 'json' | 'ndjson'): 'human' | 'json' | 'ndjson';
```

`resolveOutputMode('auto')` returns `'json'` when `!process.stdout.isTTY`, `'human'` otherwise.

### 2.13 `meta` declarations

Every command file exports a typed `meta` tuple:

```ts
export const meta: { outputSchema?: string; destructive: boolean } = { ... };
```

- `login`: `{ outputSchema: 'freelo.auth.login/v1', destructive: false }`.
- `logout`: `{ outputSchema: 'freelo.auth.logout/v1', destructive: false }`. (R13 will decide whether this is classified as destructive — deleting a stored token is local-only and fully idempotent, so R01 says `false`.)
- `whoami`: `{ outputSchema: 'freelo.auth.whoami/v1', destructive: false }`.

R02.5 walks these via the Commander program tree to emit `freelo.introspect/v1`. R01 just establishes the pattern.

**Do status-only commands (`login`, `logout`) emit an envelope?** Yes. Per architecture.md §Output modes "Every command that returns data must go through `ui/envelope.ts`", and non-TTY agents need parseable output for status commands too (did the login succeed? what profile was created? was the logout a no-op?). R01 emits a small envelope for all three commands. Flagged in Open questions only as confirmation, not as genuinely open.

### 2.14 Codegen decision

R01 hand-writes zod for the single `/users/me` envelope, the `FreeloErrorSchema` tolerant union, and the `conf` store shape. The codegen-vs-hand-zod decision is formally deferred to R03 (first multi-endpoint slice), per `.claude/skills/freelo-api/SKILL.md` §Codegen. The decision is recorded as `docs/decisions/<run-id>-01-codegen-vs-hand-zod.md` during the implementation phase.

## 3. API surface

R01 is scoped to a single Freelo endpoint — **`GET /users/me`** — used by `freelo auth login` (verifying a just-entered token before persisting) and `freelo auth whoami` (verifying a stored token and rendering identity). This section pins down everything R01 needs from the OpenAPI spec at `docs/api/freelo-api.yaml` (OpenAPI 3.0.3, `info.version: "1.0.0"` — `docs/api/freelo-api.yaml:44`).

### Base URL

Single production server, no sandbox, `/v1` is baked into the URL (there is no unversioned form):

```
https://api.freelo.io/v1
```

`docs/api/freelo-api.yaml:49-51`. The same URL is restated in prose in `info.description` at `docs/api/freelo-api.yaml:8`.

### Authentication

- Global security requirement: `basicAuth` applied to every operation by default — `docs/api/freelo-api.yaml:53-54`.
- Security scheme definition (`components.securitySchemes.basicAuth`): HTTP Basic, `scheme: basic`, with `description: "Use your email as username and API key as password"` — `docs/api/freelo-api.yaml:4759-4763`.
- The `info.description` restates this: *"Authentication is done using HTTP Basic Authentication. Use your email as username and API key as password."* — `docs/api/freelo-api.yaml:20-22`. API key is obtained from <https://app.freelo.io/profil/nastaveni>.
- `GET /users/me` inherits the global requirement — it does not override `security`, so Basic Auth is mandatory (`docs/api/freelo-api.yaml:97-143`).
- **Email case sensitivity in Basic Auth is not documented.** Store the email as the user entered it; do not normalize casing until we have observed behavior.

### `GET /users/me`

- `operationId: getUsersMe` — `docs/api/freelo-api.yaml:106`.
- `summary: Authentication health check`; `description`: *"Verifies that the provided credentials are valid. Returns 200 with the authenticated user's information. Returns 401 when credentials are invalid or missing."* — `docs/api/freelo-api.yaml:101-105`.
- No query parameters, no path parameters, no request body.
- **No `403`, `429`, `404`, or `5xx` response declared** on this operation (`docs/api/freelo-api.yaml:107-143`) — they can still occur at runtime; the CLI must handle them defensively.
- **No response headers documented** on either the `200` or `401`.

**`200` body shape** (`docs/api/freelo-api.yaml:108-129`):

```json
{
  "result": "success",
  "user": { "id": 12345 }
}
```

Both `result` and `user` are `required`, and `user.id` (integer) is the **only documented property on `user`**. Real responses are known to carry additional fields (email, fullname, avatar) that the spec omits — the zod schema uses `.passthrough()` to preserve them (see Quirks).

**`401` body shape** (`docs/api/freelo-api.yaml:130-143`):

```json
{ "errors": [ { "message": "…" } ] }
```

This is an **array of objects** each with a `message: string` property — it **contradicts the global `ErrorResponse` schema** (`docs/api/freelo-api.yaml:4803-4812`) which declares `errors` as an **array of strings**. Neither form is a superset of the other. Flagged in Quirks below.

### Common error payload

Global `ErrorResponse` (`docs/api/freelo-api.yaml:4803-4812`):

```yaml
ErrorResponse:
  type: object
  properties:
    errors:
      type: array
      items:
        type: string
  example:
    errors:
      - "Error message."
```

The schema **does not define**: a machine-readable `code`, a `requestId`, per-field validation details, or any status metadata. All discrimination must be done client-side from HTTP status + endpoint context.

The CLI synthesizes `FreeloApiError.code` from the HTTP status (these are **CLI conventions, not wire fields**):

| HTTP | `FreeloApiError.code` | Notes |
|---|---|---|
| 401 | `AUTH` | Credentials missing or invalid. For R01 this is the expected negative path on login/whoami. |
| 401 (token previously worked) | `AUTH_EXPIRED` | Promoted by the auth command when a stored token suddenly fails. Same wire status. |
| 403 | `FORBIDDEN` | Not declared on `/users/me` but handled defensively. |
| 404 | `NOT_FOUND` | Not applicable to `/users/me`; listed for completeness. |
| 429 | `RATE_LIMITED` | See Rate limiting. |
| 5xx | `SERVER_ERROR` | `retryable: true`. |

### Rate limiting

`info.description` is deliberately non-committal (`docs/api/freelo-api.yaml:24-26`):

> *"The API enforces per-user rate limits that may change over time as our infrastructure capacity grows. Do not hardcode rate limits on the client side. Instead, handle `429 Too Many Requests` responses by backing off and retrying after a delay."*

**No `RateLimit-*`, `X-RateLimit-*`, or `Retry-After` response header is documented** anywhere in the spec — neither on `/users/me` nor globally. The CLI's retry policy (`Retry-After || 1 s + jitter(0..500 ms)`, idempotent verbs only, N=3) is therefore **best-effort until we observe real 429 responses** and capture a fixture. See Open questions.

### Required headers

| Header | When | Citation / rationale |
|---|---|---|
| `User-Agent: freelo-cli/<version> (+https://github.com/vladonemo/freelo-cli)` | Every request | Required by `info.description`: *"Each request must include a `User-Agent` HTTP header."* — `docs/api/freelo-api.yaml:9`. Reinforced by `.claude/skills/freelo-api/SKILL.md` §Required headers. `<version>` is read from `package.json`. |
| `Content-Type: application/json; charset=utf-8` | Write requests (`POST`/`PUT`/`PATCH`) | `info.description`: *"The API only supports JSON format in UTF-8 encoding."* — `docs/api/freelo-api.yaml:17-18`. R01 has no writes; listed for completeness. |
| `Accept: application/json` | Every request (safe) | Not mandated by the spec, but the API is JSON-only (`docs/api/freelo-api.yaml:17-18`). Safe to send. |
| `Authorization: Basic …` | Every request | From the `basicAuth` security scheme — `docs/api/freelo-api.yaml:4759-4763`. |

**Correlation header:** no `X-Request-Id`, `X-Correlation-Id`, or similar header is documented (request or response direction). The CLI's `--request-id` flag is **client-side only** — it is echoed into the error envelope (`request_id`) and local logs for operator correlation, but is **not sent to Freelo** and **not read back** from responses.

### Quirks relevant to R01

1. **`401` body shape disagrees with `ErrorResponse`.** `/users/me` declares `errors: Array<{ message: string }>` (`docs/api/freelo-api.yaml:130-143`) while the global `ErrorResponse` (`docs/api/freelo-api.yaml:4803-4812`) declares `errors: string[]`. Recommended zod shape — a tolerant union with a normalizer that collapses both forms into `string[]` before rendering:

   ```ts
   const FreeloErrorBodySchema = z.object({
     errors: z.array(
       z.union([z.string(), z.object({ message: z.string() }).passthrough()])
     ),
   }).passthrough();

   const normalizeErrors = (body: z.infer<typeof FreeloErrorBodySchema>) =>
     body.errors.map((e) => (typeof e === "string" ? e : e.message));
   ```

2. **`user` is under-specified.** Only `user.id` is documented (`docs/api/freelo-api.yaml:118-126`). Real responses carry more (email, fullname, avatar). R01 should:
   - Use `.passthrough()` on both the envelope and `user` in `UserMeSchema`.
   - During rollout, capture a scrubbed live response to `test/fixtures/users-me.json` (no key, no email domain, no real IDs).
   - Tighten `UserMeSchema` in a follow-up slice once the fixture is in.

3. **No response headers on `/users/me`** — neither on 200 nor 401 (`docs/api/freelo-api.yaml:107-143`). The rate-limit capture path (`ApiResponse.rateLimit`) will receive `undefined` for this endpoint until headers are observed; the envelope's `rate_limit` field will be omitted.

4. **No `429` declared on `/users/me`.** The operation's `responses` map only defines `200` and `401`. Retry policy for this endpoint is defensive, not contractual.

5. **Basic Auth email casing is undocumented.** Store-as-entered; do not lower-case until confirmed.

6. **Base URL is versioned at `/v1`.** There is no unversioned form — `docs/api/freelo-api.yaml:49-51`. Schema/envelope versioning is an orthogonal CLI concern.

## 4. Data model

Zod schema sketches — not code. Shapes only; exact `.passthrough()` / `.strict()` choices noted.

**`UserMeEnvelopeSchema`** — the top-level `/users/me` response wrapper.

```
z.object({
  result: z.string(),
  user: UserMeSchema,
}).passthrough()
```

`.passthrough()` because the OpenAPI guarantees only `result` + `user`; any extra top-level fields (e.g. a `meta` block) must not fail validation.

**`UserMeSchema`** — the nested `user` object.

```
z.object({
  id: z.number().int().positive(),
  // tightened after the real fixture (Open question on fixture capture):
  // email: z.string().email().optional(),
  // fullname: z.string().optional(),
  // avatar_url: z.string().url().optional(),
}).passthrough()
```

`.passthrough()` for forward-compat. The inferred TS type is `UserMe`; the `whoami` renderer projects a narrow **allow-list** into `WhoamiResult` so human/json output is stable.

**`ConfStoreSchema`** — the on-disk `conf` shape.

```
z.object({
  schemaVersion: z.literal(1),
  currentProfile: z.string().nullable(),
  profiles: z.record(
    z.string(),
    z.object({ email: z.string(), apiBaseUrl: z.string() }).strict(),
  ),
}).strict()
```

`.strict()` on our own store — we control the writer, so unexpected fields on read means corruption.

**`AppConfig`** — frozen in-memory config.

```
type AppConfig = Readonly<{
  profile: string;
  profileSource: 'flag' | 'env' | 'conf' | 'default';
  email: string;
  apiKey: string;          // never logged, never in an envelope
  apiBaseUrl: string;
  userAgent: string;
  output: { mode: 'auto' | 'human' | 'json' | 'ndjson'; color: 'auto' | 'never' | 'always' };
  verbose: 0 | 1 | 2;      // 0 = silent, 1 = info, 2 = debug
  yes: boolean;
  requestId: string;       // uuid
}>;
```

**`WhoamiResult`** — `data` payload of `freelo.auth.whoami/v1`.

```
type WhoamiResult = {
  profile: string;
  profile_source: 'flag' | 'env' | 'conf' | 'default';
  user_id: number;
  email: string;
  full_name?: string;      // only when the real /users/me returns it
  api_base_url: string;
};
```

**`FreeloErrorSchema`** — tolerant union addressing the `errors: string[]` vs `errors: [{message}]` inconsistency.

```
z.object({
  errors: z.array(z.union([
    z.string(),
    z.object({ message: z.string() }).passthrough(),
  ])),
}).passthrough()
```

Plus a `normalizeErrors(body): string[]` helper that flattens both shapes for display and envelope emission.

## 5. Edge cases

- **Keytar native-module load fail** (Alpine, Docker without libsecret, Windows without Credential Manager reachable, native binding rebuild skew) → fallback file at `0600`, one-shot warning to stderr in human mode, pino-`warn` in json/ndjson mode.
- **`FREELO_NO_KEYCHAIN=1`** → keytar not imported at all, fallback file used from the start. No warning (opt-in).
- **`login` non-TTY, no env, no `--api-key-stdin`** → fail closed with `AUTH_MISSING`, exit 3. Never hangs on closed stdin.
- **`login` with `--api-key-stdin` but no `--email`** → `ValidationError`, exit 2.
- **`login` with env set** → skips prompts, still calls `/users/me`, still persists on success (see Open question 2 — persistence is the recommendation).
- **`login` overwriting an existing profile** → silent overwrite with `replaced: true` in the envelope and a human notice. No prompt in R01. (R13 ships the reusable confirm helper.)
- **`login` 401** → nothing persisted, exit 3, envelope message names the profile and does not echo the token.
- **`login` 429 during `/users/me`** → GET retry budget kicks in; after N=3, `RateLimitedError` exit 6; nothing persisted.
- **`login` 5xx** → `FreeloApiError` exit 4; nothing persisted.
- **`login` network failure** → `NetworkError` exit 5; nothing persisted.
- **`logout` on absent profile** → exit 0, `data.removed: false`.
- **`logout` keytar catastrophic** → swallow (we always attempt the fallback-file deletion too); only surface an error if *both* stores error on a non-not-found path.
- **`whoami` without stored creds and no env** → `ConfigError({ kind: 'missing-token' })`, exit 3 (`AUTH_MISSING`), hint `Run 'freelo auth login' or set FREELO_API_KEY + FREELO_EMAIL.`.
- **`whoami` with revoked/expired token** → 401 → `FreeloApiError({ code: 'AUTH_EXPIRED' })`, exit 3, hint `Run 'freelo auth login' to refresh.`.
- **`whoami` under pipe (non-TTY)** → `--output auto` resolves to `json`, envelope on stdout, no spinner.
- **`whoami` 429** → GET retries up to 3; exhaustion → `RateLimitedError` exit 6.
- **`-v` + silent default** → Commander counts `-v` occurrences; `-vv` is two occurrences. (Commander's `count` option or a regex on argv before parse — decide in `/plan`.)
- **`--verbose` vs `-q` conflict** — R01 does not introduce `-q` (the superseded draft did; we drop it for clarity in favor of `-v` / `-vv` counting). No conflict.
- **SIGINT mid-prompt** → `@inquirer/prompts` rejects; `handleTopLevelError` sees an abort-shaped error and exits 130.
- **SIGINT mid-request** → shared `AbortController.abort()` fires, undici rejects, `NetworkError` with `cause.name === 'AbortError'` → handler detects and exits 130 (not 5).
- **`NO_COLOR`** → `wantsColor()` returns `false` regardless of `--color`. Chalk instance is colorless.
- **`FORCE_COLOR`** → `wantsColor()` returns `true` even off-TTY. (Rare; respected for CI with color-aware viewers.)
- **`CI=true`** → does **not** flip `isInteractive` off on its own; it flips it off only when combined with non-TTY. CI systems that *do* allocate a TTY still get human output unless `--output json` is set explicitly. (Flagged in Open questions? No — architecture.md is unambiguous.)
- **Corrupt `conf` file** → zod fails → `ConfigError({ kind: 'corrupt-config' })`, exit 1, hint with file path.
- **Missing keytar binding on CI/Alpine/Docker + fallback also unwritable** → `ConfigError({ kind: 'keychain-unavailable' })`, exit 1 (see Open question on this code).
- **Empty `/users/me` user object (only `id`)** → schema passes (`.passthrough()` + only `id` required). `WhoamiResult` omits `email` / `full_name` if the server didn't return them; human renderer shows `User: <unknown> (id <N>)`.
- **`FREELO_API_BASE`** → if set, overrides the profile's `apiBaseUrl`. `--api-base` flag is not exposed in R01 (see Open questions).
- **`--request-id` with an invalid UUID** → `ValidationError`, exit 2.
- **`--output ndjson` on a single-record command** → emits the single envelope with a trailing newline. Parity with `json`.

## 6. Non-goals

- OAuth / OIDC / device-code flows. Freelo is Basic-Auth only.
- Token rotation, expiry countdown, refresh-on-401.
- Full `freelo config` surface — R02.
- Project-level `.freelorc.*` / `freelo.config.ts` resolution via `cosmiconfig` — R02.
- `freelo --introspect` — R02.5 (R01 only establishes the `meta` tuple on each command file so R02.5's walker has input).
- `--force`-style overwrite flag on `login` — R13 ships the reusable confirm helper. R01 silently overwrites with a notice.
- Schema migration runner — R01 ships `schemaVersion: 1` + a tolerant reader only.
- Multipart upload helpers — R25.
- Any Freelo endpoint beyond `GET /users/me`.
- Telemetry, analytics, error reporting off-machine. Ever.
- `-q` / `--quiet` flag — dropped from the superseded draft's design; verbosity is `-v`/`-vv` counting, silent default.
- YAML output.
- `--json` shorthand for `--output json`.

## 7. Open questions

**Resolution (2026-04-24):** all thirteen recommendations below were accepted by the human reviewer. The plan proceeds on the recommended option for each item. No follow-up sign-off required.

Each line ends with a **Recommendation** so the reviewer can tick it quickly.

### Phase 4 addendum — Q14 (test-writer finding, 2026-04-24)

14. **`scrubSecrets` did not redact camelCase `apiKey`.** `src/errors/redact.ts` declared `SECRET_KEYS = new Set([..., 'apiKey', ...])` but the lookup is `SECRET_KEYS.has(k.toLowerCase())`. `'apiKey'.toLowerCase() === 'apikey'`, which was not present in the set, so any object key literally spelled `apiKey` (the spelling used by `AppConfig`, `Credentials`, `client.ts`'s `#apiKey`, and `tokens.ts`) escaped redaction. **Resolution (2026-04-24, Phase-3 amendment authorized by user):** entry in `SECRET_KEYS` changed from `'apiKey'` to `'apikey'` so the lowercased lookup matches every casing (`apiKey`, `APIKEY`, `ApiKey`, `apikey`). `test/errors/redact.test.ts` flipped from a "documents current behavior" assertion to a positive `'[redacted]'` assertion plus a case-insensitive sweep. Closed.

1. **Exit-code reconciliation.** `architecture.md` §Exit codes and the R01 bullet in the roadmap both say `6 = rate-limited`. An older table elsewhere in the roadmap may still say `5`. Confirm `architecture.md` wins; update any lagging roadmap text in the same PR. **Recommendation:** adopt `6`, patch roadmap in-PR.

2. **Login persistence when `FREELO_API_KEY` is set.** When the operator runs `login` with env credentials, do we persist to keytar/fallback (convenience) or stay stateless (verify-only, no writes)? **Recommendation:** persist. The operator explicitly ran `login`; `whoami` already covers the verify-only case.

3. **Overwrite UX on `login`.** Three options for the existing-profile case in R01: (a) silent overwrite with a `replaced: true` flag in the envelope + human notice, (b) require `--force` now, (c) ship a minimal confirm here and replace in R13. **Recommendation:** (a). Smallest surface, no flag we'd retire.

4. **`FREELO_API_BASE` / `--api-base` exposure.** Env var is cheap and unblocks local MSW-integration testing against a non-production base. CLI flag is another flag we'd have to support forever. **Recommendation:** ship `FREELO_API_BASE` env + `profiles[].apiBaseUrl` in `conf`; defer the visible `--api-base` flag until a real consumer asks.

5. **`conf` forward-compatibility.** Ship `schemaVersion: 1` from day one (cheap) or add it later when we have something to migrate? **Recommendation:** ship the version field now; defer the migration runner.

6. **Real `/users/me` fixture capture.** The OpenAPI guarantees only `user.id`; any real response carries more. Blocks tightening `UserMeSchema` past `.passthrough()`. **Recommendation:** ship with the relaxed `.passthrough()` schema; capture and tighten during autonomous replay if credentials are present, or flag for post-merge follow-up if not (non-blocking).

7. **Error-shape tolerance.** `/users/me` 401 documents `errors: [{ message: string }]` (array of objects); global `ErrorResponse` is `errors: string[]`. Incompatible. **Recommendation:** `FreeloErrorSchema` is a tolerant union (`z.array(z.union([z.string(), z.object({message: z.string()}).passthrough()]))`); `normalizeErrors` flattens to `string[]` for display.

8. **`Retry-After` in practice.** The spec doesn't document it. Client policy assumes `Retry-After || 1 s + jitter`. **Recommendation:** ship the policy as-is; probe on first real 429 and tighten the fallback if necessary.

9. **Email-case normalization in Basic Auth.** Freelo's spec is silent on whether Basic Auth is case-sensitive on the email. **Recommendation:** store as entered, don't normalize client-side; document the answer once observed.

10. **Status-only commands (`login`, `logout`) emit an envelope too?** Per `.claude/docs/architecture.md` §Output modes, every data-returning command goes through `ui/envelope.ts`; R01 treats `login` / `logout` status as data (small envelope with profile + replaced/removed flags). **Recommendation:** yes, every command emits an envelope. Confirm and treat as closed.

11. **`ConfirmationError` in R01?** The only R01 candidate is `login` overwriting an existing profile, and we chose silent overwrite (Open question 3 recommendation (a)). **Recommendation:** `ConfirmationError` is defined (the class exists in `src/errors/`) but never thrown in R01; R13 is its first caller.

12. **`ConfigError({ kind: 'keychain-unavailable' })` exit code.** This is thrown only when keytar fails *and* the fallback-file write also fails — the operator has no way to persist. Is that exit 1 (config) or exit 3 (auth-adjacent)? **Recommendation:** exit 1. The user hasn't been rejected by Freelo; their local store is broken.

13. **`-v` / `-vv` as count option.** Commander's natural fit is `.option('-v, --verbose', '...', count)`; `-vv` as a distinct flag needs an argv pre-walk. **Recommendation:** use Commander's count mechanism on `-v`; `-vv` is `-v -v` syntactically. Document it in help text.

---

## Summary

Spec file: `docs/specs/0002-auth-and-agent-first-infra.md`.

R01 bundles authentication (`login` / `logout` / `whoami` against `GET /users/me`) with the agent-first substrate every later slice inherits: `--output auto|human|json|ndjson` global flag with non-TTY → `json` default, versioned `freelo.<resource>.<op>/v<n>` envelopes + `freelo.error/v1` error envelope, env-first credential precedence that skips keytar when env is set or `FREELO_NO_KEYCHAIN=1`, typed error taxonomy (`FreeloApiError`, `ConfigError` with `kind`-discriminated exit codes, `ValidationError`, `NetworkError`, `ConfirmationError`, `RateLimitedError`), exit-code table (`0/1/2/3/4/5/6/130`), pino silent-default logger with lazy `pino-pretty`, lazy-imported human-UX deps policed by ESLint, and `meta: { outputSchema, destructive }` tuples on every command so R02.5 can introspect the tree. API surface (§3) is populated from the parallel `freelo-api-specialist` run — `GET /users/me` with cited OpenAPI line ranges, the 401 body-shape vs global `ErrorResponse` inconsistency, required `User-Agent`, and the undocumented `Retry-After` posture. Thirteen open questions, each with a recommendation; one genuinely needs human sign-off (login persistence under env), the rest are confirmations.

## Plan

### 8.1 Files to create or modify

Grouped by layer. One line = one file, with intent. `(new)` or `(edit)` prefix. Everything stays inside R01 scope (§6).

**`src/bin/`**

- `src/bin/freelo.ts` (edit) — extend `buildProgram`: register global flags (`--output`, `--color`, `--profile`, `-v` count, `--request-id`, `--yes`/`-y`) and a pre-action hook that calls `buildAppConfig(env, opts, program)` to produce the frozen `AppConfig`, wires pino level + SIGINT `AbortController`, and stashes a `Context` on `program`. Register `auth` subcommand. Replace the bootstrap `.catch` with a two-tier handler: if `AppConfig` resolved, call `handleTopLevelError(err, appConfig.output.mode)`; otherwise fall through to the existing `writeCatastrophicError` (unchanged). `isEntryPoint` + `writeCatastrophicError` stay byte-identical.

**`src/lib/`**

- `src/lib/env.ts` (new) — sole reader of `process.stdout.isTTY` / `process.stdin.isTTY` / `NO_COLOR` / `FORCE_COLOR` / `CI`. Exports `isInteractive()`, `wantsColor(flag)`, `resolveOutputMode(flag)`. Target of the ESLint lazy-import message. Keep dependency-free.
- `src/lib/logger.ts` (new) — factory `createLogger({ level, mode, requestId, profile })`. Returns a `pino` instance on stderr; in `human` mode + TTY, dynamically `await import('pino-pretty')` and attach as transport. Serializer redacts `authorization`, `email`, `password`, `api_key`, `apiKey`, `token`. Default level `silent`; verbosity 1 → `info`, 2 → `debug`. Every child logger binds `{ request_id, profile }`.
- `src/lib/request-id.ts` (new) — `generateRequestId()` (`crypto.randomUUID()`) and `parseRequestId(input)` returning `string` or throwing `ValidationError` on non-v4.
- `src/lib/stdin.ts` (new) — `readStdinToString({ signal, trimTrailingNewline: true })` for `--api-key-stdin`. Never throws on closed stdin; returns empty string.
- `src/lib/version.ts` (unchanged) — already present; leave alone.

**`src/errors/`**

- `src/errors/config-error.ts` (edit) — reshape to discriminated union per §2.8. Constructor takes `ConfigErrorKind`, derives `code`, `exitCode`, `hintNext` from the `kind`. `code` is still a string (`CONFIG_ERROR` generic fallback, or per-kind: `AUTH_MISSING` for `missing-token`/`missing-profile`, `CONFIG_ERROR` otherwise). Expose `readonly kind` field for renderers.
- `src/errors/freelo-api-error.ts` (new) — `FreeloApiError` with `code`, `exitCode` (3 for 401, 4 otherwise), `retryable` (true for 5xx), carries `httpStatus`, `requestId`, `errors: string[]` (normalized), `rawBody` (scrubbed). Static `fromResponse({ status, body, requestId, tokenPreviouslyWorked? })` factory.
- `src/errors/validation-error.ts` (new) — exit 2, `field?`, `value?`.
- `src/errors/network-error.ts` (new) — exit 5, `retryable: true`, wraps undici `cause`. Helper `isAbort(err)` recognizing `cause.name === 'AbortError'` so callers can re-throw as SIGINT (exit 130 handled in the top-level handler).
- `src/errors/confirmation-error.ts` (new) — exit 2, defined but unused in R01.
- `src/errors/rate-limited-error.ts` (new) — exit 6, `retryable: true`, `retryAfterSec?`.
- `src/errors/redact.ts` (new) — pure function `scrubSecrets(obj): obj` used by `FreeloApiError.fromResponse` and the pino serializer so both paths share one redaction rule.
- `src/errors/handle.ts` (new) — `handleTopLevelError(err, mode): never`. Wraps non-`BaseError` as synthetic `INTERNAL_ERROR`. In `human` mode prints `message` + `hintNext` to stderr (stack only under `FREELO_DEBUG=1`/`-vv`); in `json`/`ndjson` emits `freelo.error/v1` envelope via `ui/envelope.ts`. SIGINT → exit 130. Always `process.exit(exitCode)`.
- `src/errors/index.ts` (edit) — export every new class + `handleTopLevelError` + `scrubSecrets`.

**`src/config/`**

- `src/config/schema.ts` (new) — `ConfStoreSchema` (§4, `.strict()`), `AppConfig` type, `ProfileSource` literal union.
- `src/config/store.ts` (new) — `openConfStore({ profile })` wraps `conf` with `schema` parsing; surfaces `readProfiles`, `writeProfile`, `removeProfile`, `setCurrentProfile`. On zod parse failure throws `ConfigError({ kind: 'corrupt-config', path })`. Creates file 0600. Handles the "file doesn't exist yet" path by materializing `{ schemaVersion: 1, currentProfile: null, profiles: {} }`.
- `src/config/tokens.ts` (new) — facade over keytar with file-fallback. `readToken(profile)`, `writeToken(profile, key)`, `deleteToken(profile)`. Lazy `await import('keytar')` inside the facade; if import throws or native call throws non-`ENOENT`, set `KEYTAR_UNAVAILABLE` module state and use `<confDir>/tokens.json` at 0600. `FREELO_NO_KEYCHAIN=1` pre-empts the import entirely. Emits a one-shot `pino.warn` on fallback activation (never stderr-print in `json`/`ndjson`). `deleteToken` attempts both stores, swallows "not found" on either.
- `src/config/resolve.ts` (new) — `buildAppConfig({ env, flags, program })` returns the frozen `AppConfig`. Applies per-flag precedence from §2.1. Does **not** resolve credentials yet (commands ask `resolveCredentials(appConfig)` on demand).
- `src/config/credentials.ts` (new) — `resolveCredentials(appConfig, opts)` implements §2.2 precedence. Returns `{ email, apiKey, apiBaseUrl, source: 'stdin'|'env'|'keytar'|'conf-fallback' }` or throws `ConfigError({ kind: 'missing-token', profile })`. `whoami` / `login` share this.

**`src/api/`**

- `src/api/client.ts` (new) — `createHttpClient({ email, apiKey, apiBaseUrl, userAgent, logger, signal })`. Method `request<T>({ method, path, body?, schema, signal })`. Attaches Basic Auth, UA, Accept, `X-Request-Id`, writes `Content-Type` only on bodied verbs. Parses response through the provided zod schema; 401 → `FreeloApiError` with `code: AUTH_EXPIRED`; other 4xx/5xx → `FreeloApiError` with `code: FREELO_API_ERROR`; zod fail on 2xx → `FreeloApiError` with `VALIDATION_ERROR` variant (§2.5). GET 429 retry loop (N=3, `Retry-After || 1 s` + `jitter(0..500)`). Write 429 → `RateLimitedError` immediately. Undici network failure → `NetworkError`. Abort → re-throw (handler interprets). Extracts `{remaining, resetAt}` from any of `RateLimit-Remaining` / `X-RateLimit-Remaining` / `Retry-After` into `ApiResponse.rateLimit`.
- `src/api/schemas/users-me.ts` (new) — `UserMeSchema` + `UserMeEnvelopeSchema` per §4 (both `.passthrough()`, only `user.id` required).
- `src/api/schemas/error.ts` (new) — `FreeloErrorBodySchema` tolerant union + `normalizeErrors(body): string[]` helper.
- `src/api/users.ts` (new) — `getUsersMe(client, { signal })` returning `{ user: UserMe, raw: ApiResponse }`.

**`src/ui/`**

- `src/ui/envelope.ts` (new) — `buildEnvelope({ schema, data, rateLimit?, paging?, requestId?, notice? })`. Also `buildErrorEnvelope(err)` producing `freelo.error/v1`. Envelope-key order is an insertion-order contract; document in a comment (tests assert presence, not order).
- `src/ui/render.ts` (new) — `render(mode, envelope, humanRenderer)`. `json`/`ndjson` → `JSON.stringify(env)+'\n'` to stdout. `human` → call `humanRenderer(env.data)` which returns a string; write to stdout. `auto` unreachable here (resolved at `buildAppConfig`).
- `src/ui/human/auth-login.ts` (new) — human renderer for `login` (`Logged in as …` / `Replaced token for profile …`).
- `src/ui/human/auth-logout.ts` (new) — human renderer for `logout` (`Logged out profile 'x'.` / `No credentials for profile 'x'; nothing to remove.`).
- `src/ui/human/auth-whoami.ts` (new) — labelled rows (profile, profile source, user, user id, email, api base url).
- `src/ui/styles.ts` (new; stub in R01) — exports an `styles` object that `await import`s chalk on first access. Only whoami uses a faint label color in R01.

**`src/commands/`**

- `src/commands/auth.ts` (new) — `register(program)` declares `auth` subcommand with `login`/`logout`/`whoami` children; each child imports its action from a sibling file. Exports nothing else.
- `src/commands/auth/login.ts` (new) — action + `meta = { outputSchema: 'freelo.auth.login/v1', destructive: false } as const`. Handles credential-source resolution, lazy-prompts, spinner, persistence, envelope emission.
- `src/commands/auth/logout.ts` (new) — action + `meta = { outputSchema: 'freelo.auth.logout/v1', destructive: false } as const`. Pure local; idempotent.
- `src/commands/auth/whoami.ts` (new) — action + `meta = { outputSchema: 'freelo.auth.whoami/v1', destructive: false } as const`. Resolves creds → `getUsersMe` → projects `WhoamiResult` → render.

**Test tree** (mirrors `src/`):

- `test/msw/handlers.ts` (new) — shared MSW server setup + `handlers.users-me.ok(user)`, `handlers.users-me.unauthorized()`, `handlers.users-me.rate-limited({ retryAfter? })`, `handlers.users-me.server-error(status)`, `handlers.users-me.malformed()` factories. Adds `beforeAll`/`afterEach`/`afterAll` helpers.
- `test/fixtures/users-me.ok.json` (new) — minimal `{ result: 'success', user: { id: 12345 } }`.
- `test/fixtures/users-me.ok-extended.json` (new) — scrubbed realistic body with `email`, `fullname`, `avatar_url` under `.passthrough()`.
- `test/fixtures/users-me.401.json` (new) — `{ errors: [{ message: 'Invalid token' }] }`.
- `test/fixtures/users-me.401-global.json` (new) — `{ errors: ['Invalid token'] }` — the conflicting global `ErrorResponse` shape, for the tolerant-union test.
- `test/lib/env.test.ts` (new) — TTY/NO_COLOR/FORCE_COLOR/CI matrix; `resolveOutputMode('auto')`.
- `test/lib/logger.test.ts` (new) — redaction of `authorization`/`email`/`password`/`api_key`/`token`; silent-default; pino-pretty lazy attach only in TTY+human.
- `test/lib/request-id.test.ts` (new) — generation + v4 validation; `ValidationError` on bad input.
- `test/errors/handle.test.ts` (new) — `human` vs `json` paths; non-`BaseError` → `INTERNAL_ERROR` exit 1; SIGINT-shaped error → exit 130; hint + message printed; no stack unless `FREELO_DEBUG=1`.
- `test/errors/config-error.test.ts` (new) — each `kind` → correct `code`/`exitCode`/`hintNext`.
- `test/errors/redact.test.ts` (new) — `scrubSecrets` replaces all documented keys; deep; leaves structure intact.
- `test/config/store.test.ts` (new) — create, read, update, remove profile; corrupt file → `ConfigError({ kind: 'corrupt-config' })` with file path.
- `test/config/tokens.test.ts` (new) — keytar happy path (mocked); keytar import failure → fallback file 0600; `FREELO_NO_KEYCHAIN=1` → never imports keytar; delete attempts both stores.
- `test/config/resolve.test.ts` (new) — flag > env > conf > default, per axis (`output`, `color`, `profile`, verbose-from-`FREELO_DEBUG`).
- `test/config/credentials.test.ts` (new) — `--api-key-stdin` wins over env; env wins over keytar; keytar wins over fallback; missing → `ConfigError({ kind: 'missing-token' })`.
- `test/api/client.test.ts` (new, MSW) — Basic Auth header built; UA present; 200 parsed through schema; 401 → `FreeloApiError(AUTH_EXPIRED)`; 500 → `FreeloApiError(FREELO_API_ERROR, retryable:true)`; zod fail → `FreeloApiError(VALIDATION_ERROR)`; network failure → `NetworkError`; AbortSignal propagates.
- `test/api/client.retry.test.ts` (new, MSW) — GET 429 retries 3 times with `Retry-After`; write 429 does not retry; exhaustion → `RateLimitedError`.
- `test/api/schemas/users-me.test.ts` (new) — accepts minimal body; preserves passthrough fields.
- `test/api/schemas/error.test.ts` (new) — tolerant union accepts both 401 shapes; `normalizeErrors` flattens to `string[]`.
- `test/ui/envelope.test.ts` (new) — `schema` present; `rate_limit` omitted when undefined; `request_id` included when set; error envelope shape.
- `test/ui/render.test.ts` (new) — `json` writes single newline-terminated line to stdout; `ndjson` same for single-record; `human` calls renderer.
- `test/commands/auth-login.test.ts` (new, MSW) — env-mode 200 happy path (no prompts); `--api-key-stdin` path; 401 → exit 3, nothing persisted; missing creds non-TTY → `AUTH_MISSING` exit 3; `--api-key-stdin` without `--email` → exit 2; replaces existing profile → `replaced: true` in envelope.
- `test/commands/auth-logout.test.ts` (new) — removes present profile, `removed: true`; absent profile → `removed: false`, exit 0; clears `currentProfile` when it matches; attempts both stores.
- `test/commands/auth-whoami.test.ts` (new, MSW) — env mode → 200 envelope, `profile_source: 'env'`; stored profile → envelope with correct `api_base_url`; missing creds → exit 3; 401 → `AUTH_EXPIRED` exit 3; 429 exhausted → exit 6; extended fixture → `full_name` included.
- `test/commands/auth-whoami.agent-path.test.ts` (new, MSW) — non-TTY with env credentials only: stdout has **exactly one** line, that line parses as the envelope; no top-level import of `@inquirer/prompts`/`ora`/`chalk`/`pino-pretty`/`keytar` was loaded (Vitest module-graph inspection or a `require.cache`-style assertion using `import.meta`-based probe; test doc'd as the lazy-import smoke check).

**Tooling**

- `eslint.config.js` (edit) — extend the existing `no-restricted-imports` block's message to point at `src/lib/env.ts::isInteractive` by name; add `keytar` and `conf` to the lazy list? **No** — `conf` is a hard dep (non-lazy, used on the agent path for profile metadata), and `keytar` is lazy-loaded inside `src/config/tokens.ts` only (kept off the list so the facade can import it). Document rationale in the rule comment.
- `package.json` (edit) — add deps per §8.2. Add `test/msw` path to any prettier ignore if needed.
- `tsup.config.ts` (edit if present; else defer) — ensure new `src/commands/auth/*.ts` are discoverable. `src/bin/freelo.ts` remains the single entry; tsup bundles the graph automatically, so most likely no change.
- `.changeset/<slug>.md` (new, written in Phase 7) — `minor` bump with explicit lines for each envelope schema (`freelo.auth.login/v1`, `freelo.auth.logout/v1`, `freelo.auth.whoami/v1`, `freelo.error/v1`) per the schema-stability contract.

### 8.2 New dependencies

Versions are pinned in `tech-stack.md`; this table only justifies inclusion.

| Name | Kind | Lazy? | Why (spec §) |
|---|---|---|---|
| `undici` | dep | no | HTTP transport (§2.5); agent cold-path needs it for `/users/me`. |
| `zod` | dep | no | Every network response parsed through a zod schema (§4, CLAUDE.md working agreement). |
| `conf` | dep | no | Non-secret persistent store (§2.6). On the agent cold path we `new Conf()` only when a stored profile is consulted; env-only agents still pull the module (small, no side effects at import). |
| `pino` | dep | no | Silent-default structured logger (§2.10). |
| `@inquirer/prompts` | dep | **yes** (lazy) | Login prompt on TTY (§2.11). |
| `ora` | dep | **yes** (lazy) | Login spinner on TTY (§2.11). |
| `chalk` | dep | **yes** (lazy) | Human renderers only (§2.11). |
| `pino-pretty` | dep | **yes** (lazy) | TTY + human pino transport (§2.10). |
| `keytar` | dep (optional on Alpine) | **yes** (lazy, inside `src/config/tokens.ts`) | OS keychain with fallback (§2.6). Native module; fallback covers install failure. |

`cosmiconfig`, `cli-table3`, `boxen`, `update-notifier` are **not** added in R01 — deferred to R02 / later slices.

Dev deps: no additions beyond what's already in `package.json`. MSW, Vitest, coverage, TypeScript ESLint, Prettier are all present. If `@types/keytar` is needed and not bundled, add to devDependencies.

### 8.3 Test strategy

Coverage target: 80% lines overall, 90% on `src/api/` + `src/commands/` per `sdlc.md` Phase 4. What each test **proves**, grouped:

**Unit — `src/lib/`**
- `env.test.ts`: `resolveOutputMode('auto')` returns `'json'` iff `stdout.isTTY` is false; `wantsColor` honors `NO_COLOR` (off regardless of flag), `FORCE_COLOR` (on regardless of TTY); `isInteractive()` requires both streams + `!CI`.
- `logger.test.ts`: silent-default produces zero stderr bytes; `-v` emits info lines; serializer replaces each documented key with `[redacted]`; `pino-pretty` is not imported unless TTY+human.
- `request-id.test.ts`: generated IDs match v4 regex; `parseRequestId('not-a-uuid')` throws `ValidationError` with `field: 'request-id'`.

**Unit — `src/errors/`**
- `handle.test.ts`: `human` mode prints `message` + `hintNext`, no stack, exits with `err.exitCode`; `json` mode emits `freelo.error/v1` to stderr; non-`BaseError` becomes `INTERNAL_ERROR` exit 1; SIGINT-shaped network error routes to exit 130 not 5.
- `config-error.test.ts`: each `kind` maps to the exit code in §2.8 (`missing-token` → 3, `corrupt-config` → 1, etc.); `hintNext` references the right next action.
- `redact.test.ts`: `scrubSecrets` redacts documented keys at any depth; preserves siblings; handles arrays.

**Unit — `src/api/`**
- `client.test.ts`: Authorization built as `Basic base64(email:apiKey)`; UA header matches `freelo-cli/<VERSION> (+…)`; `X-Request-Id` is forwarded from caller; 2xx body dispatched through the provided schema; 401 → `AUTH_EXPIRED`; 4xx non-401 → `FREELO_API_ERROR` (retryable false); 5xx → `FREELO_API_ERROR` retryable true; undici network error → `NetworkError`; abort re-thrown unchanged.
- `client.retry.test.ts`: 3 successive 429s on a GET → `RateLimitedError` exit 6 after budget; `Retry-After: 2` honored (jitter bounded); write 429 → `RateLimitedError` immediately, no retry.
- `schemas/users-me.test.ts`: minimal `{ result, user: { id } }` parses; `.passthrough()` preserves extra `fullname`/`email`; zod fail on missing `user.id`.
- `schemas/error.test.ts`: both 401 variants parse; `normalizeErrors` returns `string[]` in both cases.

**Unit — `src/config/`**
- `store.test.ts`: fresh path creates 0600 file with `schemaVersion: 1`; write/read round-trip; corrupt JSON → `ConfigError({ kind: 'corrupt-config', path })`.
- `tokens.test.ts`: keytar path when available; `KEYTAR_UNAVAILABLE` → fallback file written 0600; `FREELO_NO_KEYCHAIN=1` → keytar never imported (probe via mock not called); delete hits both stores and swallows not-found.
- `resolve.test.ts`: per-axis precedence (flag > env > conf > default) verified for `output`, `color`, `profile`, `verbose`.
- `credentials.test.ts`: `--api-key-stdin` > env > keytar > fallback; missing source → `ConfigError({ kind: 'missing-token' })`.

**Unit — `src/ui/`**
- `envelope.test.ts`: `schema` mandatory; `rate_limit` / `paging` / `request_id` omitted when undefined; error envelope has `error.code` / `http_status` / `retryable` / `hint_next`.
- `render.test.ts`: `json` writes one `\n`-terminated line; `ndjson` identical for single records; `human` calls the renderer and writes its return value.

**Integration — `src/commands/`** (programmatic Commander + MSW; every command × each output mode × key error paths)

- `auth-login`:
  - env-mode happy path: `AUTH_OK`, envelope emitted, profile persisted, `currentProfile` set.
  - stdin-mode happy path: key consumed from stdin, `--email` required (missing → exit 2).
  - TTY prompt path: `@inquirer/prompts` mocked, `ora` spinner starts/stops.
  - 401: nothing persisted, exit 3, envelope message names the profile, token not echoed.
  - Non-TTY, no env, no stdin: `AUTH_MISSING` exit 3, fails closed (not hung).
  - Replace existing profile: envelope `replaced: true`, human notice.
  - 5xx: `FREELO_API_ERROR` exit 4, nothing persisted.
  - Network failure: `NETWORK_ERROR` exit 5.
- `auth-logout`:
  - Present profile: `removed: true`, keytar + fallback both cleared, `currentProfile` cleared when matching.
  - Absent profile: idempotent `removed: false`, exit 0.
  - No API call regardless (asserted via MSW seeing zero requests).
- `auth-whoami`:
  - Env-mode 200: envelope with `profile_source: 'env'` and correct `user_id`.
  - Stored-profile 200: envelope with `profile_source: 'conf'` and profile's `api_base_url`.
  - Missing creds: `AUTH_MISSING` exit 3.
  - 401: `AUTH_EXPIRED` exit 3.
  - 429 exhausted: exit 6.
  - Extended fixture: `full_name` present; minimal fixture: `full_name` omitted from envelope.
  - Error envelope shape on 401 matches `freelo.error/v1` schema.

**Agent-path smoke** — one dedicated test:
- `auth-whoami.agent-path.test.ts`: spawn-style run with env creds + non-TTY; stdout contains exactly one line; that line parses as `freelo.auth.whoami/v1`; the module graph does **not** include `@inquirer/prompts`, `ora`, `chalk`, `pino-pretty`, `keytar` (walk the loader's record of imported specifiers; acceptable techniques in plan order: (1) Vitest `vi.hoisted` + spy on `await import`, (2) post-run scan of `import.meta` registry, (3) snapshot of `process.versions`-adjacent `moduleCache`. The implementer picks one in Phase 3).

### 8.4 Slicing

**Decision: one PR, staged commits.** R01 is Red-tier by blast radius (global flags, error taxonomy, envelope, HTTP client), but the constituent modules are tightly coupled — splitting would produce a first PR whose tests can't compile the HTTP client because `FreeloApiError` isn't in yet, or vice versa. A hypothetical split (PR A: errors + env + logger + envelope + handle; PR B: config + api + commands) leaves PR A untestable beyond unit level, and PR B re-opens the global-flag wiring that PR A just closed. The net result is more review surface, not less.

What **is** mandatory: staged Conventional Commits within the single PR so reviewers (and `git bisect`) can land in order. Recommended order:

1. `refactor(errors): discriminated ConfigError; add typed error taxonomy` — edits `config-error.ts`, adds `{freelo-api,validation,network,confirmation,rate-limited}-error.ts` + `redact.ts` + `handle.ts` + `index.ts`. Tests: `test/errors/**`.
2. `feat(lib): env/logger/request-id/stdin primitives` — adds `src/lib/env.ts`, `logger.ts`, `request-id.ts`, `stdin.ts`. Tests: `test/lib/**`.
3. `feat(ui): envelope + render` — adds `src/ui/envelope.ts`, `render.ts`, `human/*` renderer stubs (empty-ish). Tests: `test/ui/**`.
4. `feat(config): store + tokens + credential resolver` — adds `src/config/**`. Tests: `test/config/**`.
5. `feat(api): undici client + /users/me schemas` — adds `src/api/**`. Tests: `test/api/**`, `test/msw/handlers.ts`, fixtures.
6. `feat(bin): global flags, app config wiring, top-level error handler` — edits `src/bin/freelo.ts`. No new tests here; commands exercise it.
7. `feat(commands): auth login/logout/whoami` — adds `src/commands/auth*`. Tests: `test/commands/**`, including agent-path smoke.
8. `chore(deps): add undici, zod, conf, pino, inquirer, ora, chalk, pino-pretty, keytar` — lands with commit 5 or earlier in reality; listed last for the plan's clarity. Bundle with whichever commit first needs them to keep each commit CI-green.

Each commit must leave `pnpm test` / `pnpm typecheck` / `pnpm lint` green. Commit 6 is the one that wires everything together; if its CI fails, revert to commit 5 is a clean state.

**If the implementer reports the diff is > ~800 lines of production code** (not counting tests, which will be ~1.5× that), they should pause and propose splitting commands 6+7 into a follow-up PR — `handleTopLevelError` exists from commit 1, so `bin/freelo.ts` can land wired to it without any `auth` subcommand registered. That split keeps the global-flag contract in the first PR and lets reviewers focus on command behavior in the second.

### 8.5 Risks / flagged concerns

Phase 3 (implement) should budget time for:

1. **`keytar` on the CI matrix** (ubuntu/macos/windows × Node 20/22). Windows Credential Manager is usually fine; macOS Keychain wants a signed build; Linux needs `libsecret-1-dev` at build time. Mitigation: the fallback file is the contract; CI matrix doesn't have to successfully *use* keytar, but it must not fail install. Verify in commit 4's CI run. If a platform fails install of the native binding, declare `keytar` `optionalDependency` and adjust `src/config/tokens.ts` to treat `import('keytar')` failure identically to `FREELO_NO_KEYCHAIN=1`.

2. **`undici` global dispatcher vs MSW.** MSW 2.x intercepts `fetch` via `undici`'s interceptor API. Our client uses native `fetch` (which delegates to the global `undici` dispatcher). This combo is known-working but fragile under test pool concurrency. Mitigation: commit 5 includes a smoke test that sets up MSW, fires one `getUsersMe`, and asserts interception. If broken, either (a) call `undici.fetch` explicitly (allows dispatcher injection in tests) or (b) use MSW's Node setup with a per-suite dispatcher override.

3. **Commander `-v` count behavior.** Commander treats `-vv` as two separate `-v` occurrences only if short-option combining is enabled; otherwise `-vv` is an unknown flag. Concretely: `.option('-v, --verbose', '…', (_, prev: number) => prev + 1, 0)` + `program.configureParseOptions({ combineFlagAndOptionalValue: false })` + rely on Commander's built-in `-vv → -v -v` expansion. If `-vv` parses as unknown, fall back to an argv pre-walk in `buildProgram` before `parseAsync`. Budget: half a day to verify, implement, and test. Covered by `test/bin/verbosity.test.ts` (add to the plan if not already implied).

4. **`conf` file-create race** on the first `login` when the XDG directory doesn't exist. `conf` creates the directory synchronously at construction; two parallel `login`s (unlikely but possible under automation) can race. Mitigation: document as known; do not add mutexes in R01. Covered by the absorbing-state idempotency of `login` (last write wins; final state is valid).

5. **Top-level static import creep.** The lazy-import ESLint rule catches source files but not their transitive imports. Example: importing `ora` transitively via a helper that *looks* innocuous. Mitigation: the agent-path smoke test (`auth-whoami.agent-path.test.ts`) is the contract — if a future change pulls `ora` onto the cold path, that test fails. Keep it fast so it actually runs.

6. **Abort vs NetworkError vs exit 130.** Undici's aborted request throws a `TypeError` with `cause.name === 'AbortError'`. The client wraps all undici errors as `NetworkError`. `handleTopLevelError` must inspect `err.cause` before mapping to exit 5, and route aborts to 130 instead. Covered by `test/errors/handle.test.ts` and `test/api/client.test.ts`.

7. **Deferred decision — codegen vs hand-zod.** R01 hand-writes one endpoint's schema; the formal deferral goes into `docs/decisions/<run-id>-01-codegen-vs-hand-zod.md` during Phase 3. This plan does not prescribe a directory layout for `src/api/schemas/` that would constrain R03's decision (the single `users-me.ts` file sits flat under `schemas/`; codegen output can co-locate or move it without breakage).

8. **Out-of-scope temptations** (do **not** address in R01, per §6):
   - `config` subcommand surface → R02.
   - `--introspect` walker → R02.5.
   - `cosmiconfig` / `.freelorc.*` → R02.
   - `--api-base` flag exposure → deferred per §7 Q4.
   - Schema migration runner → deferred per §7 Q5.
   - Real fixture tightening beyond `.passthrough()` → post-merge follow-up per §7 Q6.

If any of these start bleeding in during Phase 3, treat as plan drift, stop, and update this Plan section before proceeding per `sdlc.md` §"When things go wrong".

```
ARCHITECT run=2026-04-24-2015-auth-and-agent-first-infra status=ok spec=docs/specs/0002-auth-and-agent-first-infra.md open_questions=0 new_deps=9
```
