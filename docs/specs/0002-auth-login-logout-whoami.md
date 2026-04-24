# 0002 — Auth: login / logout / whoami

**Status:** Superseded — needs re-spec against updated R01 scope
**Run:** 2026-04-24-1930-auth-login-logout-whoami
**Owner:**
**Tier:** Yellow (likely Red after re-spec — now ships envelope infra, error taxonomy, introspection-enabling `meta`, lazy-import rules)

> **⚠ This spec predates the agent-first policy in `.claude/docs/architecture.md`.** It describes a global `--json` boolean flag and a per-command JSON shape. The canonical R01 slice (see `docs/roadmap.md` §R01) now ships a versioned envelope (`freelo.<resource>.<op>/v<n>`), a `--output <auto|human|json|ndjson>` global flag with TTY-aware `auto` default, env-first credential precedence that skips the keychain, a structured error envelope (`freelo.error/v1`), lazy-loaded human-UX deps, and a pairing with R02.5 for `--introspect` discoverability.
>
> **Do not implement this spec as-is.** Re-run `/spec R01` against the updated roadmap. The body below is kept for reference only.

## Problem

The current scaffold (spec 0001, `src/bin/freelo.ts:1-52`) prints a version string and nothing else. The CLI has no way to identify a user, no place to keep a Freelo API token, no HTTP client, no typed errors, and no global flags — so every subsequent read/write slice in the roadmap (R02 onwards) is blocked on infrastructure that does not exist.

A user today cannot do anything beyond `freelo --version`. Before they can list a single project they need to authenticate, and authentication needs secure local storage, a verified HTTP call to `GET /users/me`, a typed error path for bad tokens, and a stable global-flags policy. R01 is the slice that lights up all of that while delivering three concrete commands: `freelo auth login`, `freelo auth logout`, and `freelo auth whoami`.

## Proposal

### CLI UX

Three subcommands under `freelo auth`, plus the global flags they (and every later command) inherit.

#### Global flags (registered on the root `Command` in `src/bin/freelo.ts`)

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--profile <name>` | string | `default` | Which stored profile to use. Env override: `FREELO_PROFILE`. |
| `--json` | boolean | `false` | Machine-readable output. Unset → human renderer. |
| `--color <auto\|never\|always>` | enum | `auto` | Threads into the chalk instance. `auto` honors `NO_COLOR` and `process.stdout.isTTY`. |
| `--verbose` | boolean | `false` | Raises pino level to `debug`. Mutually exclusive with `-q/--quiet` (Commander's `conflicts()`). |
| `-q, --quiet` | boolean | `false` | Suppresses spinners and non-error stdout chrome. Data output still flows. |

**Precedence** (highest wins): explicit CLI flag > env var (`FREELO_TOKEN`, `FREELO_PROFILE`, `FREELO_API_BASE` — see Open question 6) > project rc (R02, not this slice) > user `conf` > compiled default. This matches R02's precedence rule so later slices don't need to renegotiate it. Resolution happens once at startup into a frozen `AppConfig` (per `.claude/docs/architecture.md:73-83`); commands read `AppConfig`, never `process.env`.

---

#### `freelo auth login [--email <e>] [--profile <name>]`

**Purpose:** Store a Freelo API token for a profile after verifying it with a `GET /users/me` round-trip.

**Interactive flow (TTY):**
1. If `--email` omitted: prompt with `@inquirer/prompts` `input({ message: 'Freelo account email:', validate: ... })`. Validation: non-empty, looks like an email (`/.+@.+\..+/` — not RFC 5322; just enough to catch typos).
2. Prompt `password({ message: 'Freelo API token:', mask: '*' })`. Validation: non-empty after trim.
3. Issue `GET /users/me` with Basic Auth (exact header form pinned by **API surface** below).
4. On 2xx: write profile metadata via `conf`, token via `keytar` (service `freelo-cli`, account = profile name), set `currentProfile` if it was unset, print `Logged in as <Full Name> (<email>) on profile '<name>'.`
5. On 401: print `Freelo rejected that token. Nothing was saved.` and exit 3. Persist nothing.

**Non-interactive path (CI / scripts):** If `FREELO_TOKEN` is set, skip both prompts. If `--email` is supplied on the command line, use it; otherwise fall back to the email the API returns from `/users/me` (so `FREELO_TOKEN`-only login works in a CI where the operator doesn't want to encode the email). Still verifies via `/users/me`. Persistence behavior: see Open question 5.

**Fail closed:** If `process.stdin.isTTY === false` **and** `FREELO_TOKEN` is unset, exit 2 with `auth login requires either a TTY for interactive prompts or FREELO_TOKEN to be set.` Never block waiting on a closed stdin.

**Existing profile:** If `--profile <name>` already has a stored token, behavior follows Open question 4. Provisional answer: overwrite silently in this slice and print `Replaced token for profile '<name>'.`, with an explicit confirmation UX added in R13.

**Example — happy path, human:**
```
$ freelo auth login
? Freelo account email: jane@acme.cz
? Freelo API token: ********************************
Logged in as Jane Doe (jane@acme.cz) on profile 'default'.
```

**Example — happy path, env-driven:**
```
$ FREELO_TOKEN=abc123... freelo auth login --email jane@acme.cz --profile work
Logged in as Jane Doe (jane@acme.cz) on profile 'work'.
```

**Example — bad token:**
```
$ freelo auth login
? Freelo account email: jane@acme.cz
? Freelo API token: ********
Freelo rejected that token. Nothing was saved.
$ echo $?
3
```

**Exit codes:** `0` success, `2` non-TTY without token / invalid email format, `3` 401 from `/users/me`, `4` non-401 HTTP error (e.g. 500), `5` network / retries exhausted, `130` SIGINT mid-prompt. See Open question 1 for the `4` vs `5` reconciliation.

---

#### `freelo auth logout [--profile <name>]`

**Purpose:** Remove the token for a profile from both `keytar` and the `conf` fallback file. Idempotent.

**Behavior:**
- If profile exists: delete the token from keytar (or fallback), remove the profile entry from `conf.profiles`, if it was `currentProfile` clear that field. Print `Logged out of profile '<name>'.`
- If profile does not exist: exit 0 with `No stored credentials for profile '<name>'. Nothing to do.`
- Never prompts. Never writes.

**Example:**
```
$ freelo auth logout --profile work
Logged out of profile 'work'.

$ freelo auth logout --profile work
No stored credentials for profile 'work'. Nothing to do.
$ echo $?
0
```

**Exit codes:** `0` always, unless keytar itself errors catastrophically (→ `1` with the error chained as `cause`).

---

#### `freelo auth whoami [--profile <name>] [--json]`

**Purpose:** Verify the stored token and show the resolved account identity.

**Behavior:**
1. Resolve the profile (flag > env > `currentProfile` > `default`).
2. If no token is stored for that profile: exit 3 with `Not logged in on profile '<name>'. Run 'freelo auth login'.`
3. Call `GET /users/me`. On 401: exit 3 with `Stored token for profile '<name>' is no longer valid. Run 'freelo auth login'.`
4. On 2xx: render according to `--json`.

**Example — human:**
```
$ freelo auth whoami
Profile: default
User:    Jane Doe (jane@acme.cz)
User ID: 12345
API:     https://api.freelo.io/v1
```

**Example — JSON:**
```
$ freelo auth whoami --json
{
  "profile": "default",
  "userId": 12345,
  "email": "jane@acme.cz",
  "fullName": "Jane Doe",
  "apiBaseUrl": "https://api.freelo.io/v1"
}
```
The JSON shape is **exactly the zod type `WhoamiResult` serialized as-is** — see **Data model**. Because the OpenAPI spec guarantees only `user.id` on `/users/me` (see **API surface** below), `email` and `fullName` are treated as best-effort: if a real fixture confirms their field names, they appear; if the server omits them, `whoami --json` omits them and the human renderer falls back to printing only what's present. This is tracked as Open question 8.

**Exit codes:** `0` ok, `2` usage, `3` no stored creds or stored-but-rejected, `4` non-401 API error, `5` network, `130` SIGINT.

---

### Architecture and new infra

#### HTTP client — `src/api/client.ts`
- Built on `undici` (already pinned, `.claude/docs/tech-stack.md:38-44`). Default global dispatcher is fine for this slice; a shared `Agent` comes later if we need tuned pool sizes.
- Constructs `Authorization: Basic <base64(...)>` from the profile's stored token. Exact credential form (`email:token` vs `token:`) is pinned by the API-surface section below — the client just takes `{ email, token }` and formats them.
- Always sends `User-Agent: freelo-cli/<VERSION>` (`VERSION` from `src/lib/version.ts`), `Accept: application/json`, and `Content-Type: application/json` on write verbs.
- **429 handling:** read `Retry-After` (seconds or HTTP-date). Sleep `base + jitter`, where `base = Retry-After` (or 1 s if absent) and `jitter ∈ [0, 500] ms`. Retry **only on idempotent methods (GET, HEAD)**, up to **N=3** attempts total. Exhausting retries throws `FreeloApiError` with `status: 429` and exit-code mapping per the resolved table.
- **Logging:** pino `debug` line per request: `{ method, path, status, durationMs, requestId }`. Tokens never logged — the `Authorization` header is redacted.
- **Return contract:** for 2xx, parses JSON and returns it raw to the endpoint function, which is responsible for zod-validating before returning to callers (per `.claude/docs/conventions.md:33-38`). For non-2xx, throws `FreeloApiError` carrying `status`, `code`, `requestId`, and `body` (scrubbed of any `Authorization` echo).

#### Config layer — `src/config/`
- `src/config/schema.ts` — zod schema for the `conf` store:
  ```
  profiles: Record<string, { email: string; apiBaseUrl: string }>
  currentProfile: string | null
  schemaVersion: 1    // see Open question 7
  ```
  The token **is not here**. Only non-secret profile metadata.
- `src/config/secrets.ts` — thin wrapper over `keytar`:
  - `setToken(profile, token)`, `getToken(profile)`, `deleteToken(profile)`.
  - Service name: `freelo-cli`. Account key: the profile name.
  - On keytar import/load failure (common on headless Linux without libsecret, in Docker, or when the native binding fails to resolve), transparently fall back to a **sibling file**: `<conf path>/../tokens.json`, mode `0600`, shape `{ "<profile>": "<token>" }`.
  - **User-visible warning** on first fallback activation per-process: `warning: OS keychain unavailable; storing token in <path> (0600). Install libsecret for better security.` Written to stderr, suppressed under `--quiet`.
- `src/config/profiles.ts` — the small, synchronous-ish surface commands use: `loadProfile(name)`, `saveProfile(name, meta, token)`, `deleteProfile(name)`, `listProfiles()`.
- `src/config/app-config.ts` — builds the frozen `AppConfig` at process start from `{ flags, env, userConf, defaults }` and hands it to commands. The `apiBaseUrl` default is the production Freelo base; see Open question 6 for the `--api-base` / `FREELO_API_BASE` override question.

#### Error taxonomy — `src/errors/`
Extend the `BaseError` placeholder from spec 0001:
- `FreeloApiError(status, code?, requestId?, body?)` — 4xx/5xx responses. 401 is surfaced as-is; top-level handler maps it to exit 3. 429 is surfaced as-is; top-level maps per the resolved table.
- `ConfigError(kind, message)` — `kind ∈ { 'missing-token', 'missing-profile', 'keychain-unavailable', 'corrupt-config' }`. Exit 3 when `kind` is token-/profile-related, else exit 1.
- `ValidationError(field, message)` — bad CLI input or failed zod parse of args. Exit 2.
- `NetworkError(cause)` — `undici` connection/DNS/abort failures. Exit 5.
- **Top-level handler in `src/bin/freelo.ts`:** one function `handleTopLevelError(err, isJson)`. Non-JSON prints a one-line message to stderr, omits the stack unless `FREELO_DEBUG=1`. JSON mode prints `{"error":{"code":"<ERR_CODE>","message":"<msg>","requestId?":"..."}}` to stderr. Exit codes per the resolved table (Open question 1).

#### Global flags registration
- Registered on the root `Command` in `src/bin/freelo.ts` so every subcommand inherits them.
- Subcommands read them from the root via `program.optsWithGlobals()` (Commander 12+), not from their own `opts()`. This avoids per-subcommand re-declaration.
- `--color` is consumed once while building the shared chalk instance in `src/ui/styles.ts`; `auto` delegates to chalk's env detection which already handles `NO_COLOR`, `FORCE_COLOR`, and `isTTY`.
- `--verbose` / `-q` set the pino level before any API call is made.
- `--json` is globally declared but only `whoami` honors it this slice; later slices inherit the flag for free.

#### Zod schema for `/users/me`
Sketch only — the authoritative field list comes from the API-surface section below.

```
const UserMeEnvelopeSchema = z.object({
  result: z.string(),                  // e.g. "success"
  user: z.object({
    id: z.number().int().positive(),   // the only field guaranteed by the OpenAPI spec
    // real responses almost certainly include email, fullname, etc. — captured from a live
    // fixture before whoami's renderer hard-codes any field (Open question 8)
  }).passthrough(),
}).passthrough();
type UserMe = z.infer<typeof UserMeEnvelopeSchema>['user'];
```

`.passthrough()` is chosen for both the envelope and the `user` object because `docs/api/freelo-api.yaml:97-144` only names `result` and `user.id`. `.strict()` would reject every real response (which demonstrably carries more than `user.id`) and would also break the moment Freelo adds a field. The `--json` renderer projects a **narrow allow-list** (`userId`, `email`, `fullName`, plus any API-specialist-approved pass-throughs), so `.passthrough()` affects only *validation*, not what we emit. Once a scrubbed fixture is checked in (Open question 8), the inner `user` object tightens to a named `.object({ id, email, fullname, ... }).passthrough()`.

### API surface

**Base URL.** Single production server: `https://api.freelo.io/v1` (`docs/api/freelo-api.yaml:49-51`). The `/v1/` version segment is mandatory — there is no unversioned form. No staging or sandbox server is declared in the spec.

**Authentication.** HTTP Basic Auth, applied globally via `security: [{ basicAuth: [] }]` (`docs/api/freelo-api.yaml:53-54`). Scheme defined at `docs/api/freelo-api.yaml:4759-4763` (`type: http, scheme: basic`). Per `info.description` (`docs/api/freelo-api.yaml:20-22`) and the scheme's own description: **username = the user's email, password = the API key**. So `freelo auth login` must collect **both** email and token — this resolves Open question 2. `/users/me` has no per-operation `security` override (`docs/api/freelo-api.yaml:97-144`); it inherits global Basic Auth.

**`GET /users/me`.** Defined at `docs/api/freelo-api.yaml:97-144`, `operationId: getUsersMe`, summary "Authentication health check". 200 body (inline schema, no `$ref`):
```
{ result: string, user: { id: integer } }   # required: result, user, user.id
```
That is the **only** documented field on the `user` object — no `email`, `name`, `fullname`, `avatar`, `timezone`, `locale`. Real responses will carry more; we capture a scrubbed fixture before designing `whoami`'s renderer (Open question 8). The documented 401 body here is `{ errors: [{ message: string }] }` — an array of **objects** — which contradicts the global `ErrorResponse` shape `{ errors: string[] }` at `docs/api/freelo-api.yaml:4803-4812`. Which shape the server actually sends on this path is Open question 9. `FreeloErrorSchema` should be a tolerant union until we know. No 403 / 429 are documented on this operation. No response headers are documented anywhere in the spec.

**Common error payload.** Global `ErrorResponse` (`docs/api/freelo-api.yaml:4803-4812`) is `{ errors: string[] }` — no `code`, no `requestId`, no structured `errors[].field`. `FreeloApiError.code` is therefore synthesized from the HTTP status (`'AUTH'` for 401, `'NOT_FOUND'` for 404, `'RATE_LIMITED'` for 429, etc.); the `body` field stores the raw payload for debug. No correlation header (`X-Request-ID` or equivalent) is documented.

**Rate limiting.** The spec is deliberately non-committal: "limits may change over time... do not hardcode... back off on 429" (`docs/api/freelo-api.yaml:24-26`). **No `RateLimit-*` / `X-RateLimit-*` / `Retry-After` header is documented.** Whether Freelo emits `Retry-After` in practice is Open question 10 — probe on first real 429. Client policy stays as specified above: honor `Retry-After` if present, else `1 s + jitter(0..500 ms)`, idempotent GETs only, N=3.

**Other headers.**
- `User-Agent` — **required on every request** (`docs/api/freelo-api.yaml:9,13`; `.claude/skills/freelo-api/SKILL.md` §Required headers). Format: `freelo-cli/<VERSION> (+<repo-url>)`.
- `Content-Type: application/json; charset=utf-8` — the only supported request format for writes (`docs/api/freelo-api.yaml:17-18`).
- `Accept: application/json` — safe/idiomatic to send; the API is JSON-only.
- No correlation header documented.

**Quirks.**
- Error-shape inconsistency between `/users/me` 401 (`errors: [{ message }]`) and global `ErrorResponse` (`errors: string[]`) — see Open question 9.
- `/users/me` is the canonical token check per its own summary; no lighter `/ping` exists in the spec. Good — one call gives us both validity and the profile payload.
- Email case sensitivity in Basic Auth is not documented. Store as entered; do not normalize client-side (Open question 10).
- The base URL always includes `/v1`; there is no unversioned form.
- OpenAPI file version is `1.0.0` (`docs/api/freelo-api.yaml:44`). Refresh before each major phase per the `freelo-api` skill's refresh procedure.

### Data model

- **User `conf` store** (`~/.config/freelo-cli/config.json` on Linux, platform-correct elsewhere):
  ```
  {
    "schemaVersion": 1,
    "currentProfile": "default" | null,
    "profiles": {
      "<profileName>": { "email": "...", "apiBaseUrl": "..." }
    }
  }
  ```
- **Secret store** (keytar, keyed by `service=freelo-cli, account=<profileName>`) or, on fallback, a sibling `tokens.json` (`0600`):
  ```
  { "<profileName>": "<opaque token string>" }
  ```
- **In-memory `AppConfig`** (frozen), built at startup:
  ```
  {
    profile: string;
    email: string;
    apiBaseUrl: string;
    token: string;             // read from keytar/fallback on demand, not cached on disk elsewhere
    output: { json: boolean; color: 'auto'|'never'|'always'; quiet: boolean; verbose: boolean };
  }
  ```
- **`UserMe`** = `z.infer<typeof UserMeEnvelopeSchema>['user']`. The envelope itself is not surfaced to callers; endpoint functions unwrap `user` before returning.
- **`WhoamiResult`** (the `--json` payload shape):
  ```
  { profile, userId, email, fullName, apiBaseUrl, ...approved-passthroughs }
  ```

## Edge cases

- **keytar native-module load failure** on any OS (Linux without libsecret, Alpine, Docker, Windows Server without Credential Manager reachable): fall back to `tokens.json` (0600), emit the one-line warning on first activation, never crash.
- **`login` when profile already exists:** overwrite silently this slice; print `Replaced token for profile '<name>'.` See Open question 4 for the `--force` / prompt options deferred to R13.
- **`login` token rejected (401):** persist nothing (no `conf` write, no keytar write). Exit 3. Message names the profile and suggests re-checking the token; never echoes the token.
- **`login` under pipe (non-TTY) without `FREELO_TOKEN`:** exit 2 with a targeted message; do not hang waiting for stdin.
- **`login` with `FREELO_TOKEN` set:** skip prompts, still call `/users/me`, still persist (recommendation — see Open question 5 for alternative).
- **`whoami --profile <name>` where profile is not defined:** exit 3 with `Not logged in on profile '<name>'.`.
- **`logout --profile <name>` where profile is not defined:** exit 0, idempotent "nothing to do" message.
- **Clock skew / token revocation mid-session:** first 401 on any later call raises `ConfigError('missing-token', ...)` with a hint. Out of scope to detect pre-emptively.
- **429 during `login`'s `/users/me`:** honor client retry policy (idempotent GET); if retries exhaust, surface exit code per Open question 1; persist nothing.
- **Network outage during `login`:** `NetworkError` → exit 5; persist nothing. No partial writes.
- **`--verbose` and `-q/--quiet` together:** Commander's `conflicts()` rejects at parse time with exit 2.
- **SIGINT mid-prompt:** `@inquirer/prompts` rejects; top-level handler catches, exits 130, no partial writes.
- **Malformed stored `conf`:** `ConfigError('corrupt-config', ...)` with a hint to run `freelo auth login` (which will overwrite the profile). Exit 1.
- **`login` with an email that fails the email-shape check:** re-prompt in interactive mode; in non-interactive mode, exit 2.

## Non-goals

- OAuth / OIDC / device-code flows. Freelo's API is Basic-Auth token; anything else is upstream work.
- Token rotation, expiry countdown, or refresh on our side.
- Managing multiple profiles within a single invocation (one active profile per call).
- The full `freelo config` CLI surface — that's R02.
- Team/organization awareness. Tokens are per-user.
- Project-level `.freelorc` / `freelo.config.ts` resolution. That's R02.
- Fancy confirmation UX on `login` overwrite. R13 ships the reusable confirm helper.
- Editor / stdin input for the token. (The password prompt is enough; piping tokens goes via `FREELO_TOKEN`.)
- Telemetry or error reporting off-machine.

## Open questions

1. **Exit-code table conflict.** `docs/roadmap.md:49` says `5 = rate-limited`; `.claude/docs/architecture.md:29-36` says `4 = API error (4xx/5xx)`, `5 = network error`, `130 = SIGINT`. These disagree. Recommendation: adopt the `architecture.md` table (`0/1/2/3/4/5/130`) as canonical, treat 429 as a `FreeloApiError` that exits `4`, and update the roadmap in the same PR. Needs human sign-off because it changes a user-facing contract before it ships.
2. ~~**Basic Auth credential form.**~~ **Resolved** by the API surface section: `Basic base64(email:token)` per `docs/api/freelo-api.yaml:20-22,4759-4763`. `login` must prompt for both email and token. Kept in the list as a record of the resolution.
3. **Codegen vs hand-written zod.** This slice introduces the first schemas (`UserMeSchema`, the error payload, the `conf` schema). Option A: generate all API schemas from `docs/api/freelo-api.yaml` via `openapi-zod-client` (or similar) and check them into `src/api/schemas/generated/`. Option B: hand-write per-resource as each slice lands. Recommendation: **B for R01** (three fields, hand-written is faster than wiring codegen), with the codegen decision formally deferred to R03 when schemas multiply. Record the decision in `docs/decisions/<run>-01-codegen-vs-hand-zod.md`.
4. **Overwrite-prompt on `login`.** The confirmation helper ships in R13. Three options for R01: (a) silent overwrite with a one-line notice (recommended — smallest surface, no flag bleed); (b) require `--force` to overwrite, which introduces a flag we'll rename/retire when R13 lands; (c) ship a minimal confirm helper here and replace it in R13. Pick one.
5. **`FREELO_TOKEN` + `login` persistence semantics.** When the operator runs `login` with `FREELO_TOKEN` set, do we persist the token to keytar (treating env as a convenience) or stay stateless (verify-only, no writes)? Recommendation: **persist**, because the operator explicitly invoked `login` — if they wanted verify-only, `whoami` already does that. Needs sign-off.
6. **Base URL override.** Expose `--api-base <url>` and/or `FREELO_API_BASE` now (useful for MSW-integration-style local testing, enterprise staging, and future sandbox)? The roadmap is silent. Recommendation: register `FREELO_API_BASE` env + store `apiBaseUrl` in the profile so future sandboxes don't force a CLI update, but **defer** the visible `--api-base` flag until a real consumer needs it.
7. **Profile schema forward-compatibility.** When R02 adds `defaultProject`, `defaultOutputFormat`, etc., the `conf` schema grows. Ship `schemaVersion: 1` from day one with a no-op migration dispatch in `src/config/migrations.ts`, or add it later when we have something to migrate? Recommendation: **ship the version field now** (cheap), defer the migration runner until R02 actually changes the shape.
8. **Real `/users/me` response shape.** The OpenAPI guarantees only `user.id` (`docs/api/freelo-api.yaml:97-144`); any real response carries more (email, fullname, avatar, etc.). Before `whoami`'s renderer hard-codes `email` / `fullName`, capture one scrubbed fixture from a real call and check it into `test/fixtures/users-me.json`. Blocks the `--json` allow-list and the human renderer's field layout. If the fixture shows `fullname` (lowercase) rather than `fullName`, the CLI's camelCase output maps the snake/lower form to camel per a documented convention — decide now: map or pass-through verbatim? Recommendation: **map** to camelCase in the `--json` allow-list only (so CLI output is stable), pass through the raw names on `.passthrough()` validation.
9. **401 error body shape.** `/users/me`'s 401 documents `{ errors: [{ message: string }] }` (array of objects, `docs/api/freelo-api.yaml:130-143`) while the global `ErrorResponse` is `{ errors: string[] }` (`docs/api/freelo-api.yaml:4803-4812`). These are incompatible. What does the server actually emit? Recommendation: define `FreeloErrorSchema` as a **tolerant union** (`errors: z.array(z.union([z.string(), z.object({ message: z.string() }).passthrough()]))`), normalize both shapes to `string[]` for display, and revisit once we have a real 401 captured.
10. **Rate-limit headers and Basic-Auth email case.** Two small unknowns the spec is silent on: (a) does Freelo return `Retry-After` (or any `RateLimit-*` header) on 429 in practice? The client's retry policy assumes `Retry-After || 1 s + jitter`; confirm on first real 429 and tighten. (b) Does Freelo lower-case the email server-side in Basic Auth, or is the auth case-sensitive? Store as entered for now; document the answer once observed.

---

## Plan

### Notes

All ten open questions above are resolved in writing by the maintainer; the resolutions are encoded below and no new questions are introduced. Two pre-existing scaffold artefacts are being reshaped rather than created: `src/errors/config-error.ts` currently declares a flat `ConfigError` with a fixed exit code 3, and `src/errors/index.ts` re-exports only `BaseError` + `ConfigError`. Both will be edited (not replaced) so the `kind`-based exit-code mapping per spec lines 168 and 169 works and so the new error classes are re-exported from the barrel. No separate migration for the existing file content is needed beyond the edits listed.

### Files to create

| Path | Intent |
|---|---|
| `src/commands/auth.ts` | Register `auth` parent command plus `login`, `logout`, `whoami` subcommands; export `register(program: Command)` per `docs/specs/0002-auth-login-logout-whoami.md:139-147`. Delegates each subcommand to a handler in `src/commands/auth/`. |
| `src/commands/auth/login.ts` | Implement `runLogin({ appConfig, opts })`: email+token resolution, TTY/FREELO_TOKEN branching (spec lines 38-47), silent overwrite notice (Open Q4), persist-after-verify semantics (Open Q5), fail-closed on non-TTY (spec line 47). |
| `src/commands/auth/logout.ts` | Implement `runLogout({ appConfig, opts })`: idempotent delete over keytar + fallback + `conf.profiles`; clear `currentProfile` if matching (spec lines 79-99). |
| `src/commands/auth/whoami.ts` | Implement `runWhoami({ appConfig, opts })`: resolve profile → load token → call `getMe` → dispatch to `render(mode, result, renderWhoamiHuman)` (spec lines 103-135). |
| `src/api/client.ts` | Wrap `undici.request` with Basic-Auth header construction, required headers (User-Agent, Accept, Content-Type on writes), pino `debug` request logging with Authorization redacted, 429/Retry-After retry loop for idempotent verbs (N=3), typed-error throwing (`FreeloApiError` / `NetworkError`); per spec lines 141-147 and 211. |
| `src/api/users.ts` | Export `getMe(client): Promise<UserMe>` — call `GET /users/me`, parse through `UserMeEnvelopeSchema`, unwrap `.user` before returning (spec lines 203-207). |
| `src/api/schemas/user.ts` | Declare `UserMeEnvelopeSchema` and `UserMeSchema` with `.passthrough()` on both envelope and inner user (spec lines 183-195); export inferred `UserMe` type. |
| `src/api/schemas/error.ts` | Declare `FreeloErrorSchema` as tolerant union per Open Q9 resolution; export `normalizeErrors(body): string[]` for display. |
| `src/api/index.ts` | Barrel re-exporting `createClient`, `getMe`, schemas — keeps `src/commands/` importing from one place. |
| `src/config/schema.ts` | Zod schema for the `conf` store: `schemaVersion: 1`, `currentProfile: string \| null`, `profiles: Record<string, { email, apiBaseUrl }>` per spec lines 150-156 and Open Q7. |
| `src/config/store.ts` | Construct and export the singleton `conf` instance bound to the schema; apply `schemaVersion` default of `1` on first write. |
| `src/config/secrets.ts` | Wrap keytar (`service: 'freelo-cli'`, account = profile) with `setToken` / `getToken` / `deleteToken`; on keytar import/load failure fall back to `<confDir>/tokens.json` at mode `0600`; emit a one-time stderr warning per spec lines 157-161. |
| `src/config/profiles.ts` | Orchestrate `loadProfile` / `saveProfile` / `deleteProfile` / `listProfiles` across `store` + `secrets`; spec lines 162-163. |
| `src/config/app-config.ts` | Build and freeze `AppConfig` from `{ flags, env, store, defaults }` with the precedence chain in spec line 30; source `apiBaseUrl` from profile or `FREELO_API_BASE` (Open Q6). |
| `src/config/migrations.ts` | Export `assertSupportedSchema(version)` — throws `ConfigError('corrupt-config', ...)` if `version !== 1` per Open Q7; no runner yet. |
| `src/errors/freelo-api-error.ts` | Extend `BaseError` with `status`, `code` (synthesized from status), `requestId?`, `body?`; exit code `3` for 401, else `4`; spec lines 167 and 209. |
| `src/errors/validation-error.ts` | Extend `BaseError` with `field`, exit code `2`; spec line 169. |
| `src/errors/network-error.ts` | Extend `BaseError` wrapping an undici `cause`, exit code `5`; spec line 170. |
| `src/errors/handle.ts` | Export `handleTopLevelError(err, { json, debug })` — map typed error → exit code (Open Q1 table) + stderr text or `{ error: { code, message, requestId? } }` JSON; spec lines 171 and 289. |
| `src/ui/styles.ts` | Build the shared chalk instance that honors `--color`, `NO_COLOR`, `FORCE_COLOR`, `process.stdout.isTTY`; spec line 176. |
| `src/ui/render.ts` | Export `render<T>(mode: 'human' \| 'json', payload: T, humanRenderer: (p: T) => string): void` — writes JSON to stdout with trailing newline or delegates to the human renderer. |
| `src/ui/whoami.ts` | Human renderer `renderWhoamiHuman(result: WhoamiResult): string` producing the four-line output in spec lines 115-119. |
| `src/lib/logger.ts` | Export `logger` (pino) plus `setLevel(level)`; level driven by `--verbose` / `-q` / `FREELO_LOG` at startup. |
| `src/lib/jitter.ts` | Export `jitterMs(maxMs = 500, rng = Math.random): number` — single responsibility, injectable RNG so tests get determinism without mocking global `Math.random`. |
| `test/api/client.test.ts` | MSW-driven coverage: 200 happy path, 401 → `FreeloApiError` (status 401), 429 with `Retry-After` honored (sleep mocked), 429 retries exhausted → `FreeloApiError` (status 429), undici network error → `NetworkError`; assert `Authorization` header not present in any pino log output. |
| `test/api/users.test.ts` | `getMe` happy path, 401 propagation, zod rejection when envelope lacks `user.id` (malformed response). |
| `test/config/secrets.test.ts` | Keytar stubbed via module mock: happy path; `keytar.setPassword` throws → fallback file written; assert `fs.stat` returns mode `0o600` on POSIX, skip the mode check on Windows (documented); warning-once behavior. |
| `test/config/profiles.test.ts` | Save/load/delete roundtrip against an in-memory `conf` + stubbed secrets; missing-profile returns `undefined` from `loadProfile` and is idempotent from `deleteProfile`. |
| `test/config/app-config.test.ts` | Precedence resolution: flag > env > `currentProfile` > `default`; `FREELO_API_BASE` overrides profile `apiBaseUrl`; resulting object is frozen. |
| `test/errors/handle.test.ts` | Each typed error → correct exit code + stderr shape in human mode and JSON mode; `FREELO_DEBUG=1` appends stack. |
| `test/commands/auth-login.test.ts` | TTY interactive path (stubs `@inquirer/prompts`); non-TTY without token → exit 2; `FREELO_TOKEN` path persists after verify; overwrite prints notice; bad token (401) → exit 3 with nothing persisted. |
| `test/commands/auth-logout.test.ts` | Happy path, idempotent no-op on missing profile, keytar catastrophic error → exit 1 with cause chain. |
| `test/commands/auth-whoami.test.ts` | No stored creds → exit 3; stored-but-rejected → exit 3 with rephrased message; human output shape; `--json` output matches `WhoamiResult` contract in spec lines 245-256. |
| `test/fixtures/users-me.json` | Scrubbed real-response fixture — placeholder committed in Phase 3; populated from a live call before the `UserMeSchema` tightening step in the rollout below (Open Q8). |
| `test/msw/handlers.ts` | **Modify** existing scaffold file: export a named `usersMeOk` default-success handler plus `usersMeUnauthorized`, `usersMeRateLimited`, `usersMeNetworkDown` overrides for `GET :baseUrl/users/me`. |
| `docs/commands/auth.md` | User-facing reference for `auth login / logout / whoami` — placeholder file listed here so Phase 6 doesn't surprise-add it; actual content authored by `doc-writer`. |
| `docs/getting-started.md` | **Modify**: insert a "Log in" section between install and `--version`, referencing `freelo auth login`. |
| `docs/decisions/0001-codegen-vs-hand-zod.md` | Record Open Q3 resolution: hand-written zod for R01, reopen deferred to R03. Include alternatives considered and rationale. |
| `.changeset/r01-auth.md` | `minor` bump with a one-paragraph entry naming the three new commands and the infra (HTTP client, keytar-backed config, typed errors). |

### Files to modify

| Path | Intent |
|---|---|
| `src/bin/freelo.ts` | Register global flags (spec lines 22-31), call `buildAppConfig` at startup, set pino level from `--verbose` / `-q`, invoke `registerAuth(program)`, wrap `parseAsync` with `handleTopLevelError`; replace the current bare `err.message` catch. |
| `src/errors/config-error.ts` | Replace the flat `exitCode = 3` with a `kind`-discriminated constructor (`'missing-token' \| 'missing-profile' \| 'keychain-unavailable' \| 'corrupt-config'`); exit code derived per spec line 168. |
| `src/errors/index.ts` | Re-export the four new error classes + `handleTopLevelError`. |
| `docs/roadmap.md` | Align the exit-code table with `architecture.md` (Open Q1); no behavior change to the roadmap's roadmap rows, just the table. |

### New dependencies

**dependencies**

| Name | Version (pin) | Why |
|---|---|---|
| `undici` | `6.x` | HTTP client for the Freelo API (pinned by `.claude/docs/tech-stack.md:38-39`). |
| `zod` | `3.x` | Runtime validation of every API response and the `conf` schema (`tech-stack.md:40`). |
| `conf` | `13.x` | Persistent user config; platform-correct path resolution (`tech-stack.md:41`). |
| `keytar` | `7.x` | OS keychain secret storage; marked as `optionalDependencies` so install succeeds on hosts without libsecret, and the fallback file path activates transparently (spec lines 157-161). |
| `@inquirer/prompts` | `7.x` | `input` + `password` prompts for `login` (`tech-stack.md:28`). |
| `chalk` | `5.x` | Shared styles for `ui/whoami` and future renderers (`tech-stack.md:29`). |
| `ora` | `8.x` | Spinner around the `/users/me` round-trip on human-mode logins; suppressed under `--quiet` / non-TTY (`tech-stack.md:30`). |
| `pino` | `9.x` | Structured debug logging of HTTP calls (`tech-stack.md:44`). |
| `pino-pretty` | `11.x` | Pretty transport loaded only when stderr is a TTY (`tech-stack.md:44`). |

**cosmiconfig is deliberately deferred to R02.** R01 does not read `.freelorc` or `freelo.config.*`; introducing it now would add a dep the slice has no consumer for. Add in R02 alongside the `freelo config` surface.

**devDependencies**: none beyond what `docs/specs/0001-scaffold-cli.md:136-143` already installed. `msw` (pinned at 2.7.0 in `package.json:64`) covers all HTTP mocking this slice needs. `@types/node` already declares `node:fs/promises` and `node:url`.

All runtime deps are on the pre-approved list in `.claude/docs/tech-stack.md`. `keytar` is explicitly flagged as an *optional* dependency in `package.json` so the module-load failure branch (spec line 160) is reachable on real installs.

### Test strategy

- **Unit layer** covers pure code and renderers with no network or filesystem:
  - `src/lib/jitter.ts` — deterministic RNG in, bounded output (0..max).
  - `src/ui/render.ts`, `src/ui/whoami.ts`, `src/ui/styles.ts` — snapshot-free string comparisons; `--json` mode is parsed back and shape-asserted.
  - `src/errors/handle.ts` — every typed error → exit-code + stderr-shape matrix (`test/errors/handle.test.ts`).
  - `src/config/app-config.ts` — precedence resolution and frozen-ness (`test/config/app-config.test.ts`).
- **Integration layer** drives the Commander program end-to-end with MSW mocking the Freelo API:
  - `test/commands/auth-login.test.ts`, `test/commands/auth-logout.test.ts`, `test/commands/auth-whoami.test.ts` invoke `buildProgram().parseAsync([...], { from: 'user' })` with stdout/stderr captured and `process.exit` stubbed.
  - `@inquirer/prompts` is module-mocked per test to script the TTY answers; `process.stdin.isTTY` is set explicitly.
  - Keytar is always module-stubbed — no real native calls in any test.
- **API layer** (`test/api/client.test.ts`, `test/api/users.test.ts`) uses MSW at the undici request layer, not fetch-adapter tricks; confirms schema-validation failures surface as `FreeloApiError`.
- **MSW handler scope** — the default-success handler `usersMeOk` lives in `test/msw/handlers.ts` and is installed for every test; overrides are swapped in per-test via `server.use(...)`. Named overrides: `usersMeUnauthorized`, `usersMeRateLimited` (returns 429 with a `Retry-After: 1` header), `usersMeRateLimitedNoHeader` (for the jitter-only branch), `usersMeNetworkDown` (simulates a connection error).
- **Coverage targets** per `.claude/docs/sdlc.md:94` — 80% lines overall, 90% on `src/api/` and `src/commands/`. Lenient areas: `src/bin/freelo.ts`'s `isEntryPoint` branch (unreachable from the test harness; already the case in spec 0001), `src/config/secrets.ts`'s keytar-import-throws branch on OSes where a working keytar install *does* load (exercised by stubbing `setPassword`, not the import itself).
- **Platform coverage** — the keytar fallback path is platform-agnostic in tests because keytar is stubbed; on POSIX the fallback test asserts `fs.stat().mode & 0o777 === 0o600`, and the same assertion is skipped on Windows where `chmod` is a no-op (documented with a comment referencing Node's fs docs).
- **Fixture strategy** — `test/fixtures/users-me.json` starts as a placeholder with a single `user.id` so the zod schema's minimum guarantee is testable; the real fixture replaces it during rollout step 6, and at that point the inner `user` object in `UserMeSchema` is tightened from `.object({ id }).passthrough()` to `.object({ id, email?, fullname?, ... }).passthrough()` per Open Q8.

### Rollout order

Each step is a landable slice that can pass CI independently; the whole PR is squash-merged.

1. **Error taxonomy + top-level handler.** Introduce `FreeloApiError`, `ValidationError`, `NetworkError`, reshape `ConfigError` to carry `kind`, add `handleTopLevelError`, wire it into `src/bin/freelo.ts`. No new behavior yet — replaces the stub catch block. Tests: `test/errors/handle.test.ts`, updated `test/bin/version.test.ts` if the exit semantics shifted.
2. **Config layer.** Land `schema.ts`, `store.ts`, `secrets.ts` (with keytar + 0600 fallback), `profiles.ts`, `app-config.ts`, `migrations.ts`. Tests in `test/config/`. No commands yet — pure library additions.
3. **HTTP client + `/users/me` endpoint + schemas.** Land `src/api/client.ts`, `src/api/users.ts`, `src/api/schemas/{user,error}.ts`, `src/api/index.ts`. Tests in `test/api/`. Still no commands.
4. **Commands.** Land `src/commands/auth.ts` + the three subcommand modules in dependency order: `login` → `whoami` → `logout`. Tests in `test/commands/`. MSW handlers added to `test/msw/handlers.ts` during this step.
5. **Global flags wiring.** Register `--profile`, `--json`, `--color`, `--verbose`, `-q` on the root program; build `AppConfig` at startup; set pino level; call `registerAuth(program)`. Tests update `test/bin/version.test.ts` to confirm the new flags parse without breaking `--version`.
6. **Fixture capture + `UserMeSchema` tightening.** Operator makes one real `GET /users/me` call, scrubs the response into `test/fixtures/users-me.json`, and widens the inner `user` object in `UserMeSchema`. Dependent on credentials being available — flag as the one step that blocks autonomous replay if credentials are absent.
7. **Changeset + docs.** Add `.changeset/r01-auth.md`, `docs/commands/auth.md` (or reserve it for Phase 6), `docs/decisions/0001-codegen-vs-hand-zod.md`, and the `docs/getting-started.md` edit. Update `docs/roadmap.md`'s exit-code table.

### Out-of-scope for this plan

- `freelo config` command surface — lands in R02.
- Project-level `.freelorc` / `freelo.config.ts` resolution via cosmiconfig — R02 (cosmiconfig dep deferred with it).
- The `--force` / `--yes` / interactive confirmation helper on `login` overwrite — R13.
- Multipart / file upload helpers — R25.
- Any API endpoint beyond `/users/me`.
- A visible `--api-base` flag — only the `FREELO_API_BASE` env var and profile field ship this slice (Open Q6).
- A `conf`-schema migration runner — only the `schemaVersion` field and a corrupt-config guard ship now (Open Q7).
- OAuth / device-code flows, token rotation, or telemetry.

