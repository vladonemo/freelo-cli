# 0003 — `freelo config` surface (R02)

**Status:** Accepted — all 11 §7 recommendations adopted 2026-04-25; ready for /plan
**Run:** 2026-04-25-config-surface
**Owner:**
**Tier:** Yellow (new commands + new dep `cosmiconfig` + new file-discovery surface; reuses R01 infra; no auth/HTTP changes)

---

## 1. Problem

After R01 lands, the CLI has exactly one way to materialize a profile: `freelo auth login`. That's enough for a single-machine human, but not enough for any of the cases the roadmap (R02 §lines 63-78) calls out:

- An agent on CI needs to know **which profile is active right now** without parsing `auth whoami` output, and needs to know **why** (`--profile` flag? `FREELO_PROFILE` env? `conf.currentProfile`?). R01 ships `profile_source` only inside `whoami`, which is an HTTP call — too expensive for "what would I do if I ran something now?".
- A developer running `freelo` in two checkouts wants per-repo overrides (one repo defaults to `--output ndjson`, another to a specific apiBaseUrl) without re-running `auth login` and without leaking that into their global config.
- An operator with three profiles (`default`, `ci`, `staging`) wants to switch the active profile (`config use ci`) without going through the credential flow again — the credential is already in keytar.
- An agent debugging "why did this CLI invocation pick profile X?" needs a single command (`config resolve --show-source`) that prints the merged effective config with the source of each leaf — flag, env, project rc, user conf, default. Today there is no way to do this.

R01 explicitly left the rc-layer hole: `docs/specs/0002-auth-and-agent-first-infra.md:59` says *"Project-level `.freelorc.*` overrides land in R02 and slot in between `env` and `user conf`"*. R02 fills the hole, ships the seven `config` subcommands, adds `cosmiconfig` as a dependency, and extends the `ProfileSource` enum with `'rc'`. It does **not** touch credentials, the HTTP client, the envelope contract, or the error taxonomy — it consumes them.

After R02:

- `freelo config resolve --show-source --output json` emits one envelope where every leaf is `{ value, source: 'flag'|'env'|'rc'|'conf'|'default' }`, secrets redacted at the envelope-builder level.
- A `.freelorc.json` (or `.freelorc.yaml`/`.yml`) at the repo root is auto-discovered by `cosmiconfig`, validated against a strict zod schema, and slots in at the new `rc` precedence layer between env and user conf.
- `config list` / `get` / `set` / `unset` operate on the **user-conf store** only; they never write the rc file (that's a hand-edit by humans, by design).
- `config profiles` lists profiles from the conf store; `config use <name>` switches `currentProfile` after verifying the profile exists.
- Tokens stay where R01 put them (keytar + tokens.json fallback). `config set` cannot write `apiKey`.

## 2. Proposal

### 2.1 Subcommand signatures

All seven subcommands hang off a new `freelo config` parent registered by `src/commands/config.ts` (mirroring `src/commands/auth.ts`). None of them call the Freelo API. None take destructive action against credentials.

| Subcommand | Args | Subcommand-specific flags | Destructive | Output schema |
|---|---|---|---|---|
| `config list` | — | — | no | `freelo.config.list/v1` |
| `config get <key>` | `<key>` (required, positional) | — | no | `freelo.config.get/v1` |
| `config set <key> <value>` | `<key>` (required), `<value>` (required) | — | no | `freelo.config.set/v1` |
| `config unset <key>` | `<key>` (required) | — | no | `freelo.config.unset/v1` |
| `config profiles` | — | — | no | `freelo.config.profiles/v1` |
| `config use <profile>` | `<profile>` (required) | — | no (idempotent state change) | `freelo.config.use/v1` |
| `config resolve` | — | `--show-source` (boolean, default `false`) | no | `freelo.config.resolve/v1` |

Inherited globals from R01: `--output`, `--color`, `--profile`, `-v/-vv`, `--request-id`, `--yes`. The `config` commands never need `--yes` (no destructive ops in R02 — see §6) but the flag is registered globally so referencing it costs nothing.

**Per-command `meta`** (consumed by R02.5's introspector):

```ts
export const meta = { outputSchema: 'freelo.config.<op>/v1', destructive: false } as const;
```

`config use` and `config set`/`unset` mutate state but are not classified destructive: they are local-only, idempotent, and trivially reversible. R13's confirm helper does not gate them.

### 2.2 Settable keys (allow-list)

`config set` and `config unset` operate on a small allow-list. Anything outside this list is `CONFIG_KEY_UNKNOWN` (`ValidationError`, exit 2). Anything credential-shaped (`email`, `apiKey`) is `CONFIG_KEY_READONLY` (`ValidationError`, exit 2) — those go through `auth login` / `auth logout`, not `config set`.

| Key | Type / accepted values | Storage location | Notes |
|---|---|---|---|
| `output` | `'auto' \| 'human' \| 'json' \| 'ndjson'` | `defaults.output` | R01 already reads `output` from conf; R02 makes the writer reachable. |
| `color` | `'auto' \| 'never' \| 'always'` | `defaults.color` | Same. |
| `profile` | string (must be a known profile name; validated against `profiles` map at write time) | `currentProfile` | Equivalent to `config use <name>` — explicitly aliased; see §2.5. |
| `apiBaseUrl` | string (URL, validated by `z.string().url()`) | `profiles[<active-profile>].apiBaseUrl` | Per-profile, applied to the **active** profile (resolved at the time of `set`). Writing a value for an absent profile errors `CONFIG_PROFILE_NOT_FOUND`. |
| `verbose` | `'0' \| '1' \| '2'` (string-form; coerced to number, validated) | `defaults.verbose` | Strings only on the wire so set/unset/get share a single string protocol. |

**Read-only keys** (always available to `get` / `list` / `resolve`, never to `set` / `unset`):

| Key | Where it comes from | Why read-only |
|---|---|---|
| `email` | active profile in conf | Set via `auth login`. |
| `apiKey` | keytar / tokens.json | Never persisted via `config`; redacted in `resolve`. |
| `requestId` | derived per-invocation | Per-call only. |
| `yes` | flag/env per invocation | Per-call only. |
| `userAgent` | derived from `version` | Build-time constant. |
| `profileSource` | derived during resolution | Diagnostic, not configurable. |

**Coercion policy.** Every `<value>` arrives as a string from the shell. Coercion is per-key:

- `output` / `color` / `profile` / `apiBaseUrl` — kept as string, validated against a per-key zod schema.
- `verbose` — accepts the literal strings `'0'`, `'1'`, `'2'`; anything else is `VALIDATION_ERROR`.
- No truthy/falsy ambiguity — there are no boolean keys in the R02 allow-list. (`yes` is per-invocation.)

### 2.3 Output envelope shapes

Every command emits a `freelo.config.*/v1` envelope through `src/ui/envelope.ts`. None of them include `rate_limit` (no HTTP call). `request_id` is included for parity with R01 (the inherited `--request-id` is captured even when no API call is made — it's correlation for our own logs).

#### `freelo.config.list/v1`

Lists every key in the writable allow-list (§2.2) **plus** every read-only key, with current effective value and source. This is the catalog view — the user-facing answer to "what can I configure and what is it set to?".

```json
{
  "schema": "freelo.config.list/v1",
  "data": {
    "keys": [
      { "key": "output",     "value": "json",                    "source": "conf",     "writable": true  },
      { "key": "color",      "value": "auto",                    "source": "default",  "writable": true  },
      { "key": "profile",    "value": "ci",                      "source": "env",      "writable": true  },
      { "key": "apiBaseUrl", "value": "https://api.freelo.io/v1","source": "default",  "writable": true  },
      { "key": "verbose",    "value": "0",                       "source": "default",  "writable": true  },
      { "key": "email",      "value": "agent@acme.cz",           "source": "conf",     "writable": false },
      { "key": "apiKey",     "value": "[redacted]",              "source": "conf",     "writable": false }
    ]
  },
  "request_id": "..."
}
```

#### `freelo.config.get/v1`

Single-key read. Source-annotated. `apiKey` returns `"[redacted]"` literal (string), never the real value.

```json
{
  "schema": "freelo.config.get/v1",
  "data": { "key": "output", "value": "json", "source": "rc", "writable": true },
  "request_id": "..."
}
```

#### `freelo.config.set/v1`

```json
{
  "schema": "freelo.config.set/v1",
  "data": {
    "key": "output",
    "previous_value": "auto",
    "value": "json",
    "scope": "defaults",
    "profile": null
  },
  "request_id": "..."
}
```

`scope` is `'defaults'` or `'profile'` (the latter for `apiBaseUrl`). When `scope === 'profile'`, `profile` names the affected profile (the active one at write time); otherwise `null`. `previous_value` is `null` when the key was unset before the call.

#### `freelo.config.unset/v1`

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
  "request_id": "..."
}
```

Idempotent: when the key was already unset, `removed: false` and `previous_value: null`. Exit 0 either way.

#### `freelo.config.profiles/v1`

```json
{
  "schema": "freelo.config.profiles/v1",
  "data": {
    "current_profile": "ci",
    "profiles": [
      { "name": "default", "email": "jane@acme.cz", "api_base_url": "https://api.freelo.io/v1", "current": false },
      { "name": "ci",      "email": "agent@acme.cz","api_base_url": "https://api.freelo.io/v1", "current": true  }
    ]
  },
  "request_id": "..."
}
```

Tokens are not surfaced. The `current` boolean is denormalized for renderer convenience.

#### `freelo.config.use/v1`

```json
{
  "schema": "freelo.config.use/v1",
  "data": {
    "previous_profile": "default",
    "profile": "ci",
    "changed": true
  },
  "request_id": "..."
}
```

Idempotent: `config use <already-current>` returns `changed: false`, exit 0. Errors `CONFIG_PROFILE_NOT_FOUND` (exit 2) when the profile is unknown.

#### `freelo.config.resolve/v1`

The agent debugging flagship. Two modes, controlled by `--show-source`.

**Without `--show-source` (the default).** Emits the merged `AppConfig` minus credentials, with `apiKey` redacted to the literal string `"[redacted]"`:

```json
{
  "schema": "freelo.config.resolve/v1",
  "data": {
    "profile": "ci",
    "profileSource": "env",
    "email": "agent@acme.cz",
    "apiKey": "[redacted]",
    "apiBaseUrl": "https://api.freelo.io/v1",
    "userAgent": "freelo-cli/0.x.x (+https://github.com/vladonemo/freelo-cli)",
    "output": { "mode": "json", "color": "auto" },
    "verbose": 0,
    "yes": false,
    "requestId": "..."
  },
  "request_id": "..."
}
```

**With `--show-source`.** Each leaf becomes `{ value, source }`. The source enum is the extended `ProfileSource = 'flag' | 'env' | 'rc' | 'conf' | 'default'`:

```json
{
  "schema": "freelo.config.resolve/v1",
  "data": {
    "profile":       { "value": "ci",                      "source": "env" },
    "profileSource": { "value": "env",                     "source": "derived" },
    "email":         { "value": "agent@acme.cz",           "source": "conf" },
    "apiKey":        { "value": "[redacted]",              "source": "conf" },
    "apiBaseUrl":    { "value": "https://api.freelo.io/v1","source": "default" },
    "output":        {
      "mode":  { "value": "json", "source": "rc" },
      "color": { "value": "auto", "source": "default" }
    },
    "verbose":       { "value": 0, "source": "default" },
    "yes":           { "value": false, "source": "default" },
    "requestId":     { "value": "...", "source": "flag" }
  },
  "request_id": "..."
}
```

`source: 'derived'` is used for `profileSource` itself (it is the source of the profile value, so it has no further source). The `output` object is annotated leaf-wise (`mode` and `color` separately), not at the object level — agents inspecting drift expect leaf-level annotations.

**Redaction lives in the envelope builder, not the renderer.** A new `src/ui/envelopes/config-resolve.ts` (or method on the existing builder) takes the resolved `AppConfig` + the source map and emits the redacted envelope. The human renderer never sees the real `apiKey`. This is defence in depth — see R01's `src/errors/redact.ts` pattern.

### 2.4 Precedence chain (final, with rc layer)

R01 left a hole between env and user conf. R02 fills it.

| Layer | Read from | Writable by | Notes |
|---|---|---|---|
| 1. flag | `Commander` parsed argv | `--<flag>` per invocation | Highest. |
| 2. env | startup snapshot of `process.env` | env vars | `FREELO_*` prefixed. |
| 3. **rc** (new in R02) | `cosmiconfig` walk from `process.cwd()` | hand-edit `.freelorc.*` | Strict zod, unknown keys rejected. |
| 4. conf | `~/<conf-path>/freelo-cli/config.json` | `auth login`, `config set`, `config unset`, `config use` | Per-user persistent. |
| 5. default | hard-coded constants | n/a | Lowest. |

Per-flag chains in R01 (`--output`, `--color`, `--profile`, etc.) get the rc layer slotted in between env and conf without touching their existing implementations. The rc loader returns a `Partial<RcConfig>` (§4); `buildPartialAppConfig` consumes it as a new optional input (`rc: Partial<RcConfig>`) and consults it after env, before conf.

Project-level `.freelorc.*` overrides apply **per process invocation, system-wide for that process** — the rc walks up from `process.cwd()`, exactly once at startup, and the resulting partial config is frozen into `AppConfig`. No cwd changes mid-process.

Tokens are **never** read from the rc file. Even if a user puts `apiKey: '...'` in a `.freelorc.yaml`, the rc schema rejects it (`.strict()`) and the loader throws `CONFIG_RC_INVALID` (exit 2). Same for `email`. This keeps the rc file safe to commit to a repo (subject to the user double-checking — we cannot stop them committing other secrets).

### 2.5 Per-profile defaults vs. global defaults

**Recommendation (open in §7 for human sign-off):** the conservative path — defaults live in a new top-level `defaults` map in the conf store, **not** per-profile. Schema bumps from `1` to `2`. Migrator adds an empty `defaults: {}` to existing v1 stores.

Rationale:

- The two consumers we have (`output` mode, `color`) are user-machine-level preferences, not project-or-account-level. A user wants `output: ndjson` on their CI machine and `output: human` on their laptop, but they want the same setting whether they're authenticated as `default` or `ci`. Per-profile defaults mostly duplicate the configuration.
- `apiBaseUrl` is genuinely per-profile (it's part of the credential record — different staging endpoints under different auth). It already lives in `profiles[<n>].apiBaseUrl`. R02 doesn't move it.
- Per-profile defaults cost a level of indirection in `buildPartialAppConfig` for every key, with no concrete user request driving it. Defer until a real use case.

So the conf store grows from:

```
{ schemaVersion: 1, currentProfile, profiles }
```

to

```
{ schemaVersion: 2, currentProfile, profiles, defaults: { output?, color?, verbose? } }
```

`apiBaseUrl` continues to live in `profiles[<n>].apiBaseUrl`; `config set apiBaseUrl <url>` writes there using the active profile. This is the only key with `scope: 'profile'` in the R02 allow-list.

If the human picks the per-profile-defaults alternative during review, the open question (§7 #1) calls it out and the conf shape is `profiles[<n>] = { email, apiBaseUrl, defaults: { output?, color?, verbose? } }` instead. The plan in `/plan` will branch on this decision, not the spec.

### 2.6 `cosmiconfig` integration

**Discovery.** Walk up from `process.cwd()` looking for, in order:

1. `.freelorc` — JSON content
2. `.freelorc.json`
3. `.freelorc.yaml`
4. `.freelorc.yml`

JS / TS configs (`freelo.config.js`, `freelo.config.mjs`, `freelo.config.ts`) are deliberately **not** loaded in R02 — see §7 for the open question. Loading user code on every CLI invocation is a security surface we don't take on without an explicit ask. JSON + YAML are declarative and bounded.

**Module loader.** `cosmiconfig` ESM, no JS/TS loader configured (we omit the loader for `.js` / `.ts` extensions; with no extensions registered, cosmiconfig won't touch them). YAML loader uses `js-yaml` (cosmiconfig's bundled choice).

**Sync vs async.** Use the synchronous variant (`cosmiconfigSync`). Startup config resolution is synchronous in R01 (`buildPartialAppConfig`); making it async would force `bin/freelo.ts` to top-level-await. The cost (blocking I/O for one or two file reads at startup) is invisible.

**Caching.** Cosmiconfig caches by default. We use the cache — every CLI invocation is a fresh process, so the cache is per-process and never observes stale data.

**Schema validation.** The loader returns either `null` (no rc found) or `unknown`. We then `RcConfigSchema.parse(loaded.config)` and throw `ConfigError({ kind: 'corrupt-rc', path: loaded.filepath })` on failure. `.strict()` so unknown keys throw — agents need predictable errors for typos.

**Profile-scoped sections inside the rc.** Two shapes are conceivable:

```yaml
# Shape A — flat
output: json
color: never
profile: ci
```

```yaml
# Shape B — profile-scoped
profile: ci
profiles:
  ci:
    output: json
    color: never
  default:
    output: human
```

R02 supports **Shape A only**. The rc file expresses **the user's preferred defaults at this directory tree**, not multiple profile configurations — that's what the conf store's `profiles` map is for. Shape B duplicates conf semantics in a less-good location. If the user wants different defaults per profile, R02 says "use the env var" (`FREELO_OUTPUT=ndjson freelo …`) or "switch profiles via `config use` and live with one default". This is captured in §7 only as confirmation; recommendation is to ship Shape A.

**`profile` key in the rc.** The rc file may set `profile: ci`. If env also sets `FREELO_PROFILE=dev`, **env wins** (it's higher precedence). The rc layer's `profile` is just another writable key — it slots in at layer 3 of the precedence chain.

**Examples.**

A `.freelorc.json` at repo root:

```json
{ "output": "json", "color": "never", "profile": "ci" }
```

A `.freelorc.yaml`:

```yaml
output: ndjson
verbose: 1
```

### 2.7 Examples

**Agent-style: discover the active profile and its source, no HTTP call.**

```
$ freelo config get profile --output json
{"schema":"freelo.config.get/v1","data":{"key":"profile","value":"ci","source":"env","writable":true},"request_id":"..."}
$ echo $?
0
```

**Agent-style: print the merged effective config with sources.**

```
$ FREELO_OUTPUT=ndjson freelo config resolve --show-source --output json
{"schema":"freelo.config.resolve/v1","data":{"profile":{"value":"default","source":"default"},"output":{"mode":{"value":"ndjson","source":"env"},"color":{"value":"auto","source":"default"}},"email":{"value":"jane@acme.cz","source":"conf"},"apiKey":{"value":"[redacted]","source":"conf"},...},"request_id":"..."}
```

**Agent-style: switch the active profile, idempotently.**

```
$ freelo config use ci --output json
{"schema":"freelo.config.use/v1","data":{"previous_profile":"default","profile":"ci","changed":true},"request_id":"..."}
$ freelo config use ci --output json
{"schema":"freelo.config.use/v1","data":{"previous_profile":"ci","profile":"ci","changed":false},"request_id":"..."}
```

**Human (TTY): list configurable keys with current values and sources.**

```
$ freelo config list
KEY          VALUE                           SOURCE   WRITABLE
output       json                            conf     yes
color        auto                            default  yes
profile      ci                              env      yes
apiBaseUrl   https://api.freelo.io/v1        default  yes
verbose      0                               default  yes
email        agent@acme.cz                   conf     no
apiKey       [redacted]                      conf     no
```

**Human: set a default and confirm.**

```
$ freelo config set output json
output: 'auto' -> 'json' (defaults).
```

**Error: unknown key.**

```
$ freelo config set fooBar 1 --output json
{"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","message":"Unknown config key 'fooBar'.","http_status":null,"request_id":"...","retryable":false,"hint_next":"Run 'freelo config list' for the catalog of writable keys.","docs_url":null}}
$ echo $?
2
```

**Error: read-only key.**

```
$ freelo config set apiKey sk-... --output json
{"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","message":"Config key 'apiKey' is read-only.","http_status":null,"request_id":"...","retryable":false,"hint_next":"Run 'freelo auth login' to update credentials.","docs_url":null}}
$ echo $?
2
```

**Error: corrupt rc file.**

```
$ freelo config resolve
{"schema":"freelo.error/v1","error":{"code":"CONFIG_ERROR","message":"Project rc file at /path/.freelorc.yaml has unexpected keys: token","http_status":null,"request_id":"...","retryable":false,"hint_next":"Remove disallowed keys; tokens are stored via 'auth login', not in the rc file.","docs_url":null}}
$ echo $?
2
```

(`CONFIG_RC_INVALID` is the internal `code`; it surfaces as the public `CONFIG_ERROR` per the R01 catalog. Exit 2 because it's user-correctable input. See §7 for the exit-code question.)

## 3. API surface

**None — local only.**

R02 makes zero HTTP calls. None of the seven subcommands hit Freelo. The CLI's authentication state is consulted only via the existing `src/config/credentials.ts` helpers (read-only, used by `config resolve`'s "what would my credentials be?" computation). Tokens are never decrypted into the envelope; their presence/absence is queryable, but the value is not.

This is a deliberate scope choice. The roadmap entry's value proposition (`config resolve` for agent debugging, profile management without re-running login) is purely local. Adding any HTTP touchpoint here (e.g. "validate apiBaseUrl by hitting `/users/me`") expands the surface to retry/rate-limit/network-error policy without buying anything that `auth whoami` doesn't already give the user.

If a future slice wants "`config use <profile>` verifies the profile's token before switching", that's a separate change with its own spec. Today: switch the pointer, exit 0, and let the user run `auth whoami` to verify.

## 4. Data model

Zod schema additions and changes — shapes only, exact `.strict()` / `.passthrough()` choices noted.

### 4.1 `RcConfigSchema` (new, in `src/config/rc-schema.ts`)

The schema for `.freelorc.*` files. `.strict()` so typos are visible failures.

```ts
const RcConfigSchema = z.object({
  output:     z.enum(['auto', 'human', 'json', 'ndjson']).optional(),
  color:      z.enum(['auto', 'never', 'always']).optional(),
  profile:    z.string().min(1).optional(),
  apiBaseUrl: z.string().url().optional(),
  verbose:    z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
}).strict();

type RcConfig = z.infer<typeof RcConfigSchema>;
```

Notes:
- No `email`, no `apiKey`, no `apikey` — those keys hitting `.strict()` is an explicit failure mode.
- `verbose` is the numeric form (rc files are typed; only the CLI `<value>` arg is string-coerced). Set/unset on `verbose` accepts the string forms `'0'/'1'/'2'`.
- All keys optional — an empty `{}` is a valid (no-op) rc.

### 4.2 `ConfStoreSchema` change (existing, in `src/config/schema.ts`)

Schema version bumps from `1` to `2`. New top-level `defaults` field. Existing `profiles[*]` shape unchanged (one of the §7 open questions; the recommendation is to leave `profiles[*]` alone and grow `defaults` at the top level).

```ts
const DefaultsSchema = z.object({
  output:  z.enum(['auto', 'human', 'json', 'ndjson']).optional(),
  color:   z.enum(['auto', 'never', 'always']).optional(),
  verbose: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
}).strict();

const ConfStoreSchema = z.object({
  schemaVersion: z.literal(2),
  currentProfile: z.string().nullable(),
  profiles: z.record(
    z.string(),
    z.object({ email: z.string(), apiBaseUrl: z.string() }).strict(),
  ),
  defaults: DefaultsSchema,
}).strict();
```

**Migration runner** — single forward step, in `src/config/store.ts`:

```ts
function migrateV1toV2(raw: unknown): unknown {
  if (typeof raw === 'object' && raw !== null && (raw as { schemaVersion?: unknown }).schemaVersion === 1) {
    return { ...(raw as object), schemaVersion: 2, defaults: {} };
  }
  return raw;
}
```

`readStore` runs `migrateV1toV2` on the raw conf object before zod-parsing. Migration is **read-only-on-read** — the migrated shape is *not* written back until the next `writeStore` call (which happens organically the next time `auth login`, `config set`, `config unset`, or `config use` runs). If the user only ever reads, they keep their v1 file forever; the in-memory representation is v2. This avoids surprising file timestamps from a pure read.

Backward compatibility check: a v2 store on an older CLI build (a downgrade) fails strict zod and throws `corrupt-config` (exit 1). We accept this — downgrades aren't supported and the error surface is clean.

### 4.3 `ProfileSource` extension (existing, in `src/config/schema.ts`)

```ts
// before
export type ProfileSource = 'flag' | 'env' | 'conf' | 'default';

// after
export type ProfileSource = 'flag' | 'env' | 'rc' | 'conf' | 'default';
```

Plus a derived-only literal for `config resolve --show-source` self-reference:

```ts
export type SourceLiteral = ProfileSource | 'derived';
```

`'derived'` appears only in the resolve envelope (`profileSource`'s own source — see §2.3). It is not part of `ProfileSource` itself, so existing R01 sites that switch on `ProfileSource` (notably `src/commands/auth/whoami.ts:18-27`) are unaffected.

### 4.4 `AppConfig` shape

Unchanged — R02 doesn't add new resolved fields. The new rc layer feeds the same fields R01 already resolved (`profile`, `output.mode`, `output.color`, `verbose`, `apiBaseUrl`).

### 4.5 New types for the `config` envelopes

```ts
type ConfigKeyEntry = {
  key: string;
  value: string | number | boolean | null;
  source: ProfileSource;
  writable: boolean;
};

type ConfigListData    = { keys: ConfigKeyEntry[] };
type ConfigGetData     = ConfigKeyEntry;
type ConfigSetData     = {
  key: string;
  previous_value: string | number | boolean | null;
  value: string | number | boolean;
  scope: 'defaults' | 'profile';
  profile: string | null;
};
type ConfigUnsetData   = {
  key: string;
  previous_value: string | number | boolean | null;
  removed: boolean;
  scope: 'defaults' | 'profile';
  profile: string | null;
};
type ConfigProfilesData = {
  current_profile: string | null;
  profiles: Array<{ name: string; email: string; api_base_url: string; current: boolean }>;
};
type ConfigUseData      = {
  previous_profile: string | null;
  profile: string;
  changed: boolean;
};
type ConfigResolveData  =
  | AppConfigPublic                          // when --show-source is false; apiKey is the literal "[redacted]"
  | ConfigResolveAnnotated;                  // when --show-source is true

type AppConfigPublic = Omit<AppConfig, 'apiKey'> & { apiKey: '[redacted]' };

type ConfigResolveAnnotated = {
  // exactly the AppConfigPublic shape, but every leaf is { value, source }
  // (see §2.3 for the example)
};
```

These types live alongside the renderer files in `src/ui/human/config-*.ts` and the data builders in `src/config/list.ts` / `src/config/resolve.ts`.

### 4.6 Zod for the writable allow-list

A per-key validator map, in `src/config/keys.ts`:

```ts
const WRITABLE_KEYS = {
  output:     z.enum(['auto', 'human', 'json', 'ndjson']),
  color:      z.enum(['auto', 'never', 'always']),
  profile:    z.string().min(1),
  apiBaseUrl: z.string().url(),
  verbose:    z.enum(['0', '1', '2']).transform((s) => Number(s) as 0 | 1 | 2),
} as const;

const READONLY_KEYS = ['email', 'apiKey', 'requestId', 'yes', 'userAgent', 'profileSource'] as const;
```

`config set <key> <value>` looks up the key in `WRITABLE_KEYS`, parses, persists. Unknown key → `VALIDATION_ERROR` with `code: 'VALIDATION_ERROR'`, internal kind `CONFIG_KEY_UNKNOWN`. Read-only key → `VALIDATION_ERROR`, internal kind `CONFIG_KEY_READONLY`.

## 5. Edge cases

- **No conf file yet** (fresh install, no `auth login` ever run) — `config list` works; `defaults` is empty, `profiles` is empty, `currentProfile` is `null`. Every key shows `source: 'default'` except where env or rc overrides.
- **No rc file in the cwd tree** — cosmiconfig returns `null`, the rc layer is silently skipped, precedence proceeds to conf.
- **rc file with unknown key** — `ConfigError({ kind: 'corrupt-rc', path })`, exit 2 (proposed; see §7 question on the existing taxonomy's `corrupt-config` exit 1 vs a new `corrupt-rc` exit 2). Hint points at the bad keys.
- **rc file present but empty `{}`** — valid; no-op layer.
- **rc file with `apiKey` or `email`** — strict zod rejects → `corrupt-rc`; hint says "tokens go through `auth login`".
- **`config get <unknown-key>`** — `VALIDATION_ERROR` exit 2 (`CONFIG_KEY_UNKNOWN`). Not "empty data" — agents asked for a specific thing and it does not exist; that's an error, not success.
- **`config get apiKey`** — succeeds, returns `value: "[redacted]"`. The key is read-only but it is *known*. The point is to let `config list`-style introspection round-trip safely.
- **`config set` writing the value already in place** — succeeds, `previous_value === value`, exit 0. Idempotent.
- **`config set apiBaseUrl <url>` with no active profile** (fresh install, `currentProfile === null`) — `ConfigError({ kind: 'missing-profile', profile: 'default' })`, exit 3, hint `Run 'freelo auth login' first.`. (`apiBaseUrl` is per-profile; without a profile there's nothing to write to.)
- **`config unset` on an already-unset key** — exit 0, `removed: false`, `previous_value: null`.
- **`config unset email`** or **`config unset apiKey`** — `VALIDATION_ERROR` (`CONFIG_KEY_READONLY`); read-only keys cannot be unset via `config`. Hint points at `auth logout`.
- **`config use <unknown-profile>`** — `ValidationError` (`CONFIG_PROFILE_NOT_FOUND`), exit 2, hint `Run 'freelo auth login --profile <name>' to create it, then 'freelo config use <name>'.`. Does **not** create on miss.
- **`config use <current-profile>`** — exit 0, `changed: false`. Idempotent.
- **`config resolve` without credentials** — succeeds. `email` shows `value: ""` (or omitted) with `source: 'default'`; `apiKey` shows `value: "[redacted]"` *literal* whether or not a real token exists, so agents cannot distinguish "no token" from "token redacted" via `config resolve` alone. (See §7 question on whether to surface a `has_token: boolean`.)
- **`config resolve --show-source` with the rc file overriding output** — output's `mode` shows `source: 'rc'`, not `'conf'`.
- **Concurrent invocations** — `conf` performs writes atomically; concurrent `config set` calls race the way `auth login` already races. R02 inherits R01's behavior, no new locking.
- **`--profile <x>` flag with `config get profile`** — returns `value: x`, `source: 'flag'`. The flag wins, even though the user didn't ask `config` to do anything profile-related.
- **rc validation under `--output json`** — error envelope on stderr exit 2; stdout untouched.
- **Schema-version mismatch (downgrade)** — v2 store, older CLI binary parsing it as v1: zod fails, `corrupt-config` exit 1. Documented; no auto-recovery.
- **Migration during `config set`** — if the conf is v1 on disk, the very next `writeStore` writes v2. The v1 → v2 transition is invisible to the user.
- **`-v` verbose flag set via `config set verbose 2`** — value is a string on the wire (`'2'`), coerced to number, stored as `2` (number) in `defaults.verbose`. `config get verbose` returns `value: '2'` (string) for protocol consistency with set/unset. (Captured as a §7 confirmation question — the str-on-wire / num-in-store split is an asymmetry.)
- **`config list` under `--output ndjson`** — emits one envelope (the `freelo.config.list/v1` envelope). The `data.keys` array is part of the single envelope. We do **not** emit one envelope per key in ndjson mode; this is parity with `auth whoami` and with R01's "single-record commands emit one envelope regardless" rule.

## 6. Non-goals

- **Writing the rc file via `config set`.** The rc file is a hand-edit by the human/repo author. `config set` writes to the user-conf store. (Future slice could add `--scope rc` if there's demand; not now.)
- **`config edit`** (open `$EDITOR` on the conf file). Out of scope; users can edit the conf file directly if they really want to.
- **JS / TS rc files** (`freelo.config.js`, `.mjs`, `.ts`). See §7 for the open question. Default-no.
- **YAML output mode.** Existing non-goal; R02 doesn't change that.
- **Multi-tenant / org-level config.** Not a thing in the Freelo API.
- **Encrypted rc files.** The rc file rejects `apiKey` and `email` precisely so it doesn't need to be encrypted.
- **Auto-creating profiles via `config use`.** That's `auth login`'s job.
- **HTTP-validating `apiBaseUrl` on `config set`.** No network calls in R02.
- **Per-profile defaults map.** Recommendation in §2.5 keeps this scope-out; if the human reverses the decision in §7, scope changes. Default: not in this slice.
- **Schema-migration runner v2 → v3.** The migrator is a single forward step. Future slices add their own migration steps.
- **`config import` / `config export`.** No use case yet.
- **Destructive-flag classification on `config use` / `config set`.** Local, idempotent, reversible — `destructive: false`. R13's confirm helper is not invoked.

## 7. Open questions

> **Resolution (2026-04-25):** All 11 recommendations below were accepted by the human gate. The planner treats every "Recommendation:" as a load-bearing decision; do not relitigate.

Each line ends with a **Recommendation**.

1. **Per-profile defaults vs. global defaults map.** §2.5 recommends global (top-level `defaults: { output?, color?, verbose? }` with `apiBaseUrl` staying per-profile). The alternative is `profiles[<n>].defaults`. **Recommendation:** global `defaults` map. Cheaper, matches the use cases we have, matches R01's `buildPartialAppConfig` shape. **If reversed:** schema bumps to a different v2 shape, `config set <key>` always writes to the active profile, store migration changes accordingly, and the `freelo.config.set/v1` envelope's `scope` field becomes always `'profile'`.

2. **Where `config set <key>` writes.** Tied to #1. With the global-`defaults` recommendation, `output`/`color`/`verbose` write to `defaults`, `apiBaseUrl` writes to the active profile, `profile` writes to `currentProfile`. This is asymmetric but matches the data model. **Recommendation:** ship the asymmetry; document it in `config list`'s `scope` column.

3. **JS / TS rc files (`freelo.config.{js,mjs,ts}`).** Loading user code on every CLI invocation is a security surface — a malicious node_modules-shaped path or a `.freelo.config.js` with side effects runs implicitly. Cosmiconfig's default JS loader executes them. **Recommendation:** **JSON + YAML only in R02.** Defer JS/TS until a real consumer asks for it; if/when added, gate behind an explicit allow-list or a flag like `FREELO_ALLOW_JS_CONFIG=1`.

4. **`config resolve` showing `apiKey` at all.** Two options: (a) include `"apiKey": "[redacted]"` literal on every resolve, (b) hide the field entirely. (a) is consistent with the rest of the redacted-string pattern and lets agents see "yes there is a key, no I won't tell you" in one shot. (b) avoids confusion with environments where `[redacted]` looks like a real value to a sloppy parser. **Recommendation:** (a). It's a string literal, the schema says so, agents that switch on `apiKey === '[redacted]'` work; agents that confuse `[redacted]` for a real token are broken. Optional companion: a `has_token: boolean` field on the `--show-source` shape so agents don't have to round-trip through `auth whoami`. Captured as §7 #4b below.

   **4b.** Add `has_token: boolean` to the `config resolve` envelope (both `--show-source` and not), reflecting whether keytar / tokens.json holds a token for the active profile? **Recommendation:** yes — it's cheap, it's purely informational, and it solves the "did I lose my token?" debugging case without an HTTP call. If accepted, fold into §2.3 and §4.5.

5. **`corrupt-rc` exit code.** Existing `corrupt-config` (R01) is exit 1 ("config broken"). An invalid rc file is more like user-correctable input (the user wrote a bad value, and the fix is in the file they edited). **Recommendation:** add a new `ConfigErrorKind` of `'corrupt-rc'` mapped to `code: 'CONFIG_ERROR'`, `exitCode: 2` (user-correctable), separate from `corrupt-config`'s exit 1. Captured in `src/errors/config-error.ts`. (Note that `architecture.md` exit-code table already accommodates this — exit 2 is "usage / arg validation".)

6. **`verbose` set/get protocol asymmetry.** `config set verbose 2` accepts the string `'2'`, stores `2` (number). `config get verbose` returns `'2'` (string). **Recommendation:** keep the asymmetry — set/unset/get all use the string-on-wire convention (a single value type for `<value>` simplifies the parser). Document in `config get`'s help text.

7. **rc-file profile-scoped sections (Shape B in §2.6).** Recommendation is "no, Shape A only". Confirm or pivot. **Recommendation:** Shape A. Less rope; if needed later, R02-followup can lift the restriction.

8. **`config use <profile>` token verification.** Should `use` make a `/users/me` call to verify the token still works, before switching `currentProfile`? **Recommendation:** **no** — `use` is a pointer move. Verification is what `auth whoami` is for. Adds HTTP/error-policy surface for no clear gain. (R02 stays "no API surface".)

9. **`config list` ordering and stability.** The order of keys in the `data.keys` array is part of the envelope contract (agents may rely on it). **Recommendation:** declare a fixed order — writable keys first (alphabetical), then read-only keys (alphabetical). Document in §2.3. If an agent depends on order, it's a stable order. Field-add stays minor; key-order change would be a breaking bump.

10. **Do `config` commands include `request_id` in the envelope?** R01 includes `request_id` only when an HTTP call happened. R02 has no HTTP. **Recommendation:** include `request_id` anyway (use the inherited `--request-id` / generated UUID). It's free, agents that correlate logs across calls keep working, and it preserves envelope-shape parity with R01's commands.

11. **`config set profile` vs. `config use`.** Both can switch `currentProfile`. **Recommendation:** keep both, document `config use <name>` as the preferred form (it has its own envelope with `previous_profile` + `changed`); `config set profile <name>` is the consistency-with-other-keys form. They are aliases that emit different envelopes.

---

**Summary box for the orchestrator:**

```
ARCHITECT run=2026-04-25-config-surface status=ok spec=docs/specs/0003-config-surface.md open_questions=11 new_deps=1
```

---

## 8. Plan

The plan is a checklist for the implementer. Every §7 recommendation is treated as locked. The plan does not introduce new design decisions; where multiple file layouts are equally valid, the chosen one is named explicitly and the alternative recorded inline as `// alt:` in the relevant TODO.

### 8.1 Files to create or modify

Grouped by directory. Each line: path → one-line intent. Counts at end of the section.

#### `src/config/`
- **`src/config/schema.ts`** *(modify)* — Bump `ConfStoreSchema`'s `schemaVersion` from `z.literal(1)` to `z.literal(2)`. Add new `DefaultsSchema` (strict, optional `output`/`color`/`verbose`) and embed as `defaults` field on `ConfStoreSchema`. Add `'rc'` to `ProfileSource` union. Add new exported `SourceLiteral = ProfileSource | 'derived'` for the resolve envelope. `AppConfig` / `PartialAppConfig` are **unchanged** in shape (R02 doesn't add resolved fields).
- **`src/config/store.ts`** *(modify)* — Update `DEFAULT_STORE` literal to `schemaVersion: 2` with `defaults: {}`. Add `migrateV1toV2(raw: unknown): unknown` (per spec §4.2) and call it inside `readStore` *before* zod parsing. Migration is **read-only-on-read**: do not call `writeStore` during migration. Add three new mutators: `setDefault<K extends keyof Defaults>(key: K, value: Defaults[K]): void`, `unsetDefault(key: keyof Defaults): { previous: unknown }`, `setProfileApiBaseUrl(name: string, url: string): void`. Each calls `readStore` → spread → `writeStore`. Existing `writeProfile` / `setCurrentProfile` / `removeProfile` unchanged.
- **`src/config/rc-schema.ts`** *(new)* — Export `RcConfigSchema` (z.object, `.strict()`) per §4.1, plus inferred `RcConfig` type. No runtime logic.
- **`src/config/rc-loader.ts`** *(new)* — Export `loadRcSync(cwd: string): { config: RcConfig; filepath: string } | null`. Uses `cosmiconfigSync` with `searchPlaces: ['.freelorc', '.freelorc.json', '.freelorc.yaml', '.freelorc.yml']` and `loaders` explicitly mapped (no JS/TS — see §2.6). Parses against `RcConfigSchema`; on zod failure throws `ConfigError({ kind: 'corrupt-rc', path: result.filepath })` with a `hintNext` listing the offending keys. Returns `null` when no file found. Uses module-level cosmiconfig instance; reset hook exported for tests (`_resetRcCache()`).
- **`src/config/resolve.ts`** *(modify)* — Add optional `rc?: RcConfig` to `BuildAppConfigInput`. Slot the rc layer in `buildPartialAppConfig` between env and conf for `profile`, `output`, `color`, `verbose`, `apiBaseUrl`. **`apiBaseUrl` from rc applies globally** (not per-profile) — that's the rc layer's semantic; per-profile `apiBaseUrl` still wins from conf when set. The bin entrypoint becomes responsible for calling `loadRcSync` and passing the result down (see `src/bin/freelo.ts` below). Also add a new exported `buildSourceMap(input, partial)` returning `Record<keyof PartialAppConfig, ProfileSource>` so `config resolve --show-source` can emit per-leaf sources without re-deriving precedence (this lives next to `buildPartialAppConfig`; it is small enough to share its signature).
- **`src/config/keys.ts`** *(new)* — The writable allow-list per §4.6 (`WRITABLE_KEYS`, `READONLY_KEYS`). Plus three small helpers: `parseValue(key, rawString)` returns the validated value or throws `ValidationError` with `field: key`; `keyScope(key): 'defaults' | 'profile' | 'currentProfile'`; `isReadOnlyKey(key)`. No I/O.
- **`src/config/list.ts`** *(new)* — `buildConfigListData(partial: PartialAppConfig, sourceMap, hasToken: boolean): ConfigListData`. Emits the `keys` array in the **fixed order** mandated by §7 #9: writable keys (alphabetical: `apiBaseUrl`, `color`, `output`, `profile`, `verbose`), then read-only keys (alphabetical: `apiKey`, `email`, `profileSource`, `requestId`, `userAgent`, `yes`). `apiKey` value is the literal string `"[redacted]"`. Pure function, no I/O.
- **`src/config/resolve-data.ts`** *(new)* — `buildConfigResolveData(partial: PartialAppConfig, email: string | null, hasToken: boolean, sourceMap, opts: { showSource: boolean }): ConfigResolveData`. Two branches per §2.3. **Redaction lives here** (§2.3 "redaction at builder, not renderer" rule): `apiKey` is hardcoded to `"[redacted]"` regardless of input. `has_token` field included in both branches per §7 #4b. `email` may be `""` when no profile is configured (§5 edge case); `source` is `'default'` in that case.
- **`src/config/has-token.ts`** *(new — small, but separate so commands don't import the full credential resolver)* — Export `hasToken(profile: string): Promise<boolean>` that returns `true` when `readToken(profile)` returns non-null. Wraps the existing `tokens.ts:readToken`. Used by `config resolve` and `config list` only.

#### `src/errors/`
- **`src/errors/config-error.ts`** *(modify)* — Extend `ConfigErrorKind` with `{ kind: 'corrupt-rc'; path: string }`. Add to the `resolveFields` switch: `code: 'CONFIG_ERROR'`, `exitCode: 2`, `hintNext: 'Remove disallowed keys; tokens are stored via auth login, not in the rc file. Edit ${path}.'` per §7 #5. Existing kinds (`missing-token`, `missing-profile`, `keychain-unavailable`, `corrupt-config`) unchanged.

#### `src/commands/`
- **`src/commands/config.ts`** *(new)* — Mirrors `src/commands/auth.ts`. Exports `register(program, getConfig, env)` that creates `program.command('config')` and delegates to seven `register*` files in `src/commands/config/`.
- **`src/commands/config/list.ts`** *(new)* — Action handler. Calls `getConfig`, calls `hasToken(profile)`, calls `buildSourceMap`, calls `buildConfigListData`, builds the `freelo.config.list/v1` envelope (no `rate_limit`, includes `request_id` per §7 #10), renders via `render(mode, env, renderListHuman)`. Exports `meta = { outputSchema: 'freelo.config.list/v1', destructive: false }`.
- **`src/commands/config/get.ts`** *(new)* — Positional `<key>`. Looks up the key's current value + source via the same builders the list command uses. Unknown key → `ValidationError` (`CONFIG_KEY_UNKNOWN` internal kind, code `VALIDATION_ERROR`, exit 2). Read-only key still returns successfully (`config get apiKey` → `value: "[redacted]"` per §5).
- **`src/commands/config/set.ts`** *(new)* — Positional `<key> <value>`. Step 1: `parseValue(key, value)` (throws `ValidationError` on coercion failure). Step 2: read-only key → `ValidationError` with hint `Run 'freelo auth login' to update credentials.` Step 3: dispatch by `keyScope(key)`:
  - `'defaults'` → `setDefault(key, value)`. Envelope `scope: 'defaults'`, `profile: null`.
  - `'profile'` → `setProfileApiBaseUrl(currentProfile, value)`. If `currentProfile === null` → `ConfigError({ kind: 'missing-profile', profile: 'default' })`, exit 3 (§5).
  - `'currentProfile'` (key === `'profile'`) → validate the target exists in `store.profiles`; if not → `ValidationError` with `CONFIG_PROFILE_NOT_FOUND` internal kind, exit 2; else `setCurrentProfile(value)`. Note: this is the alias path for `config use`, but emits `freelo.config.set/v1` envelope (different shape) per §7 #11.
  - Always include `previous_value` (`null` when key was unset). Idempotent: writing the existing value succeeds with `previous_value === value`.
- **`src/commands/config/unset.ts`** *(new)* — Positional `<key>`. Read-only key → `ValidationError`. For `'defaults'` keys: `unsetDefault(key)`, `removed: true` if previous existed, else `false`. For `apiBaseUrl`: clear by re-writing the profile without the override — but R01's profile shape requires `apiBaseUrl` (it's not optional). **Plan-time risk:** see §8.6.1. For `profile` (`currentProfile`): `setCurrentProfile(null)`, `removed: true` if a previous current profile existed. Idempotent.
- **`src/commands/config/profiles.ts`** *(new)* — No args. Reads `store`, builds `ConfigProfilesData`, emits `freelo.config.profiles/v1`. Renders human as a small table-like list (lazy-loaded `cli-table3` if used; alt: plain labelled rows like `auth-whoami` to avoid the lazy-import dance — see §8.5).
- **`src/commands/config/use.ts`** *(new)* — Positional `<profile>`. No HTTP per §7 #8. Reads `store`, validates `profile in store.profiles` (else `ValidationError` `CONFIG_PROFILE_NOT_FOUND`, exit 2), captures `previous_profile = store.currentProfile`, calls `setCurrentProfile(profile)`, emits `freelo.config.use/v1` with `changed: previous_profile !== profile`. Idempotent.
- **`src/commands/config/resolve.ts`** *(new)* — Flag `--show-source` (default `false`). Action: read partial via `getConfig`, look up `email` from active profile in store (or `""`), `hasToken(profile)`, build `sourceMap`, call `buildConfigResolveData(...)`, emit `freelo.config.resolve/v1`. Human renderer prints labelled rows; under `--show-source` each row appends `(source: <s>)`.

#### `src/ui/human/`
- **`src/ui/human/config-list.ts`** *(new)* — `renderConfigListHuman(data: ConfigListData): string`. Tabular labelled output (no `cli-table3` — pad columns manually, parity with `auth-whoami`). Columns: KEY, VALUE, SOURCE, WRITABLE.
- **`src/ui/human/config-get.ts`** *(new)* — `renderConfigGetHuman(data: ConfigGetData): string`. One line: `<key>: <value> (source: <source>)`. Read-only annotation when applicable.
- **`src/ui/human/config-set.ts`** *(new)* — `renderConfigSetHuman(data: ConfigSetData): string`. `<key>: '<previous_value>' -> '<value>' (<scope>[, profile <profile>]).`
- **`src/ui/human/config-unset.ts`** *(new)* — `renderConfigUnsetHuman(data: ConfigUnsetData): string`. Either `<key>: removed (was '<previous_value>') (<scope>).` or `<key>: not set; nothing to do.`
- **`src/ui/human/config-profiles.ts`** *(new)* — `renderConfigProfilesHuman(data: ConfigProfilesData): string`. Lists profiles, one per line, marking the current with `*`.
- **`src/ui/human/config-use.ts`** *(new)* — `renderConfigUseHuman(data: ConfigUseData): string`. Either `Switched profile: <previous> -> <profile>.` or `Profile already active: <profile>.`
- **`src/ui/human/config-resolve.ts`** *(new)* — `renderConfigResolveHuman(data: ConfigResolveData): string`. Two branches by shape (presence of `.value` on a leaf indicates `--show-source` mode). Always renders `apiKey: [redacted]`.

#### `src/bin/`
- **`src/bin/freelo.ts`** *(modify)* — In `run()`, after computing `env` and before parsing, call `loadRcSync(process.cwd())` (wrapped in try/catch — a `ConfigError({kind:'corrupt-rc'})` should propagate to the same `handleTopLevelError` path that other startup errors use, so wrap the call inside `try`/catch and stash the result for `resolveConfig`). Update `resolveConfig(program, env)` to also accept the `rc` partial and pass it into `buildPartialAppConfig`. Register the new `config` command tree (`registerConfig(program, getAppConfig, env)`) immediately after `registerAuth`.

#### `package.json` / dependencies
- **`package.json`** *(modify)* — Add `"cosmiconfig": "^9.0.0"` to `dependencies`. **Implicit transitive consideration:** `cosmiconfig@9` ships with `js-yaml` as a *direct dependency* of cosmiconfig (it's bundled in cosmiconfig's default loaders). Therefore **no separate `js-yaml` direct dep is required**. Confirmed by checking cosmiconfig's published `package.json` — `js-yaml` is in its `dependencies`, not `peerDependencies`. **Conclusion: exactly one new direct dep (`cosmiconfig`).** No new devDeps — `js-yaml`'s types are not needed in source (we never import `js-yaml` directly).

#### `.changeset/`
- **`.changeset/config-surface-r02.md`** *(new)* — Conventional changeset with `freelo-cli: minor`. Body must call out: (a) new `config` command tree (additive); (b) **conf store schema bump v1→v2** with one-shot read migration (forward-compatible, downgrade unsupported); (c) `ProfileSource` union extension (minor — adding a literal); (d) new envelope schemas `freelo.config.{list,get,set,unset,profiles,use,resolve}/v1` (additive). The schema bump is called out per CLAUDE.md §Working agreements ("Schema bumps need a dedicated changeset line").

#### Tests — see §8.3 below.

#### Docs — out of scope for /plan; addressed in Phase 6 `/document`. Plan note only: `docs/commands/config.md` plus seven examples is the Phase 6 ask.

**Source-file count summary:**
- `src/config/`: 2 modify, 6 new (`rc-schema`, `rc-loader`, `keys`, `list`, `resolve-data`, `has-token`).
- `src/errors/`: 1 modify.
- `src/commands/`: 1 new (`config.ts`) + 7 new in `src/commands/config/`.
- `src/ui/human/`: 7 new.
- `src/bin/`: 1 modify.
- Root: 1 modify (`package.json`), 1 new (changeset).
- **Total:** 4 modify, 22 new files in `src/`/root (excluding tests).

### 8.2 New dependencies

- **`cosmiconfig` (^9.0.0)** — runtime dep. Imported eagerly (top-level `import` is fine; `cosmiconfig` is **not** on the lazy-human-deps list in `eslint.config.js:64-82`, and its bundle cost is acceptable on the agent path because rc discovery is universal).
- **`js-yaml`** — *not* a direct dep. Already a transitive dep via `cosmiconfig`. Confirmed.
- **No new devDeps.** `@types/js-yaml` not needed (we never import it).

### 8.3 Test strategy

No MSW handlers are needed in R02 (no HTTP). Fixture rc files live under `test/fixtures/rc/`. Coverage target: 80% lines, ≥90% on `src/commands/config/` and `src/config/` per `.claude/docs/sdlc.md` §Phase 4.

#### Unit tests (`test/config/`, `test/errors/`)
- **`test/config/rc-loader.test.ts`** *(new)* — Cases:
  - returns `null` when no rc file in cwd tree;
  - parses `.freelorc.json` (fixture);
  - parses `.freelorc.yaml` (fixture);
  - parses `.freelorc` (no extension, JSON-content fixture);
  - rejects unknown key (`apiKey`) with `ConfigError({kind:'corrupt-rc'})` exit 2;
  - rejects malformed YAML (parse error) with `ConfigError({kind:'corrupt-rc'})`;
  - **Shape B input is rejected** (a `profiles:` key triggers strict-zod failure);
  - empty `{}` is valid no-op;
  - JS/TS rc files are NOT loaded (place a `freelo.config.js` fixture next to a `.freelorc.json` and confirm only the JSON is loaded).
- **`test/config/rc-schema.test.ts`** *(new)* — Direct zod schema tests: each writable key accepted, each invalid value rejected, unknown keys rejected.
- **`test/config/keys.test.ts`** *(new)* — `parseValue` round-trips per key; rejects unknown key; `keyScope` returns expected scope; `isReadOnlyKey` true for read-only set.
- **`test/config/store.test.ts`** *(modify)* — Add cases:
  - v1 file on disk: `readStore` returns v2-shaped object (with empty `defaults`);
  - read does NOT write back (file timestamp unchanged);
  - subsequent `writeStore` persists v2 shape;
  - new `setDefault` / `unsetDefault` / `setProfileApiBaseUrl` round-trip;
  - downgrade scenario (handcrafted v2 file parsed by code expecting v1) — covered by an explicit test that asserts `corrupt-config` exit 1 if `schemaVersion=99` is encountered.
- **`test/config/resolve.test.ts`** *(modify)* — Add cases:
  - rc layer overrides conf for `profile`, `output`, `color`, `verbose`, `apiBaseUrl`;
  - env beats rc;
  - flag beats env beats rc beats conf beats default (full ladder);
  - `buildSourceMap` returns correct `'rc'` source for rc-sourced fields;
  - rc with `apiBaseUrl` applies when no profile-conf override present.
- **`test/config/list.test.ts`** *(new)* — `buildConfigListData` output:
  - key order matches §7 #9 fixed order;
  - `apiKey` value is literal `"[redacted]"`;
  - `writable` flags correct;
  - per-key `source` matches the source map.
- **`test/config/resolve-data.test.ts`** *(new)* — Both branches (`--show-source` true/false). Apikey is always `[redacted]`. `has_token` reflects mock. Email empty when no profile.
- **`test/config/has-token.test.ts`** *(new)* — `true` when `readToken` returns non-null, `false` when null.
- **`test/errors/config-error.test.ts`** *(modify)* — Add case: `corrupt-rc` kind → code `CONFIG_ERROR`, exit 2, hint mentions the path.

#### Command-level tests (`test/commands/config/`)
Each file invokes the registered Commander program in-process (parity with `test/commands/auth/*.test.ts`), captures stdout/stderr, asserts envelope shape exactly. No MSW needed.

- **`test/commands/config/list.test.ts`** *(new)* — Happy path (envelope shape, fixed key order, `apiKey: [redacted]`); `--output json` and `--output ndjson` parity (single envelope in both); inherits `--profile`.
- **`test/commands/config/get.test.ts`** *(new)* — `get profile`, `get output`, `get apiKey` (returns redacted), unknown key (`VALIDATION_ERROR` exit 2), `get` with no key arg (Commander error).
- **`test/commands/config/set.test.ts`** *(new)* — Set each writable key happy path; unknown key error; read-only key error; set `apiBaseUrl` with no current profile → `ConfigError missing-profile` exit 3; set `profile` to non-existent name → `VALIDATION_ERROR` exit 2; idempotent re-write (`previous_value === value`); `verbose '2'` coerces correctly.
- **`test/commands/config/unset.test.ts`** *(new)* — Unset existing default → `removed: true`; unset already-unset → `removed: false`; unset read-only → error; idempotency.
- **`test/commands/config/profiles.test.ts`** *(new)* — Empty store, populated store with current profile, populated store with `currentProfile: null`.
- **`test/commands/config/use.test.ts`** *(new)* — Switch profile (changed: true); switch to current (changed: false); unknown profile (error); no HTTP — assert no fetch occurred (mock undici, expect no calls).
- **`test/commands/config/resolve.test.ts`** *(new)* — Default mode emits flat shape with `apiKey: '[redacted]'` and `has_token`; `--show-source` emits annotated shape; `profileSource` self-row has `source: 'derived'`; rc-overridden field has `source: 'rc'`; integrates with rc fixture.

#### Fixtures
- **`test/fixtures/rc/valid-json/.freelorc.json`** *(new)* — `{"output":"json","color":"never","profile":"ci"}`
- **`test/fixtures/rc/valid-yaml/.freelorc.yaml`** *(new)* — `output: ndjson\nverbose: 1\n`
- **`test/fixtures/rc/valid-noext/.freelorc`** *(new)* — JSON content.
- **`test/fixtures/rc/invalid-unknown-key/.freelorc.json`** *(new)* — `{"apiKey":"sk-..."}` — must trigger strict-zod rejection.
- **`test/fixtures/rc/invalid-yaml/.freelorc.yaml`** *(new)* — Malformed YAML.
- **`test/fixtures/rc/empty/.freelorc.json`** *(new)* — `{}`.
- **`test/fixtures/rc/js-not-loaded/.freelorc.json`** *(new)* — Valid JSON.
- **`test/fixtures/rc/js-not-loaded/freelo.config.js`** *(new)* — `throw new Error('should not load')` — the fact that the test passes proves the JS loader is disabled.
- **`test/fixtures/rc/shape-b-rejected/.freelorc.yaml`** *(new)* — Profile-scoped Shape B (per spec §2.6) — must be rejected.

Cosmiconfig is invoked with `cwd` set to the fixture directory; tests use a small helper that sets `process.cwd()` for the duration of the test (via `vi.spyOn(process, 'cwd')` — same pattern as existing tests).

#### Integration test (the agent flow, top-level)
- **`test/bin/config-flow.test.ts`** *(new)* — Drives `run()` end-to-end with a temp `process.cwd()` and a temp `XDG_*` for the conf store. Covers:
  1. fresh install: `config list` works, all sources `default`/`conf` empty.
  2. After `config set output json`: `config get output` returns `value:'json'`, `source:'conf'`.
  3. With rc fixture in cwd: `config resolve --show-source` shows `output.mode.source === 'rc'`.
  4. Corrupt rc file: top-level error envelope on stderr, exit 2, stdout untouched.
  5. `--output json` (default in non-TTY) confirmed for every config subcommand.

### 8.4 Rollout order (proposed slicing)

R02 is medium-sized (estimated ~600-800 LoC including tests). Recommended slicing: **3 PRs**, each independently green on CI.

- **PR 1 — Store v2 + RC layer (no commands).** Files:
  - `src/config/schema.ts` (modify), `src/config/store.ts` (modify), `src/config/rc-schema.ts`, `src/config/rc-loader.ts`, `src/config/resolve.ts` (modify, including `buildSourceMap`), `src/config/keys.ts`, `src/config/has-token.ts`, `src/errors/config-error.ts` (modify), `src/bin/freelo.ts` (modify — rc loader integration only, no `config` command yet), `package.json` (cosmiconfig dep).
  - Tests: `rc-loader.test.ts`, `rc-schema.test.ts`, `keys.test.ts`, `has-token.test.ts`, `store.test.ts` (extended), `resolve.test.ts` (extended), `config-error.test.ts` (extended), all RC fixtures.
  - **Demonstrable value:** rc files now influence `auth whoami`'s precedence ladder. No new commands.
  - **Changeset entry:** `feat: read .freelorc.{json,yaml} for project-level overrides; conf schema v1→v2`.
- **PR 2 — Read-only commands (`list`, `get`, `profiles`, `resolve`).** Files:
  - `src/config/list.ts`, `src/config/resolve-data.ts`, `src/commands/config.ts`, `src/commands/config/list.ts`, `src/commands/config/get.ts`, `src/commands/config/profiles.ts`, `src/commands/config/resolve.ts`, `src/ui/human/config-{list,get,profiles,resolve}.ts`, `src/bin/freelo.ts` (register `config` parent).
  - Tests: `list.test.ts`, `resolve-data.test.ts`, command tests for these four, integration test for the read flow.
  - **Demonstrable value:** agents can introspect config without HTTP.
  - **Changeset entry:** `feat: freelo config list/get/profiles/resolve`.
- **PR 3 — Mutating commands (`set`, `unset`, `use`).** Files:
  - `src/commands/config/{set,unset,use}.ts`, `src/ui/human/config-{set,unset,use}.ts`.
  - Tests: command tests for these three, integration test additions.
  - **Changeset entry:** `feat: freelo config set/unset/use`.

If the implementer prefers, **PRs 2 and 3 can be merged into one** (they share no surface with PR 1 and the surface is small). PR 1 must land first because it owns the schema bump. **Do not** ship PR 2/3 without PR 1.

### 8.5 Conventions to enforce

The implementer must enforce these or the reviewer (`code-reviewer` agent) will block:

1. **No `cli-table3` in `config list`'s renderer.** Use manual column padding, parity with `src/ui/human/auth-whoami.ts`. Rationale: `config list` runs on agent paths constantly (e.g. CI debugging) and the lazy-import discipline says human-UX deps are off-limits except behind `isInteractive()`. Manual padding keeps the renderer pure-string and zero-dep.
2. **`cosmiconfig` is *not* lazy.** It's a bounded, small dep used universally on every cold start. Top-level `import` is correct. The ESLint `no-restricted-imports` rule does NOT cover it (verified at `eslint.config.js:64-82`).
3. **Redaction at the envelope-builder.** `apiKey` is forced to the literal string `"[redacted]"` inside `src/config/list.ts` and `src/config/resolve-data.ts`. The renderer never sees the real value. This is defence-in-depth (R01 §redact pattern).
4. **`request_id` always included** in config envelopes per §7 #10. Use `appConfig.requestId` — it is generated even when no API call happens.
5. **`config` commands include `meta`** export per §2.1 — the introspector slated for R02.5 reads it.
6. **No `any`.** Use `unknown` + zod for the `cosmiconfig` raw load result.
7. **Conventional Commits + changeset rule.** PR 1 needs the schema-bump callout; PRs 2/3 need their own changeset lines.
8. **Strict zod.** Both `RcConfigSchema` and `DefaultsSchema` are `.strict()` — typos must blow up loud.
9. **No HTTP from `config` commands.** Reviewer will check imports — `src/api/client.ts` must not appear in any `src/commands/config/*` file. (`config resolve` only consults `hasToken`, which is keytar/file I/O, not network.)
10. **Migration is read-only-on-read.** `migrateV1toV2` returns the migrated object; it does not call `writeStore`. Test asserts file mtime unchanged after a `readStore` on a v1 file.

### 8.6 Plan-time risks

The spec is locked, so these are flagged as risks for the implementer rather than re-opened questions.

#### 8.6.1 `apiBaseUrl` is required on the v1 profile shape
`src/config/schema.ts:13` declares `z.object({ email: z.string(), apiBaseUrl: z.string() }).strict()` — `apiBaseUrl` is non-optional. `config unset apiBaseUrl` therefore cannot literally remove the field; doing so would invalidate the profile.

**Resolution for the implementer:** treat `config unset apiBaseUrl` as "reset to the default API base" — i.e. write `'https://api.freelo.io/v1'` (the `API_BASE_DEFAULT` constant in `resolve.ts`) and emit `removed: true` only when the previous value differed from the default. The envelope's `previous_value` reports the literal previous value. Document this asymmetry in the changeset and in `docs/commands/config.md` (Phase 6).

Alternative considered (and not chosen): make `apiBaseUrl` `.optional()` in the v1 profile shape. Rejected because that's a wider schema change and R01 already shipped with the required form; loosening it would be a minor breaking change to existing v1 stores' invariants.

#### 8.6.2 `buildPartialAppConfig` already calls `safeReadStore` internally
`src/config/resolve.ts:134` reads the store inside `buildPartialAppConfig` to find `currentProfile`. Adding rc layer reads makes the function I/O-heavy on every cold start. We accept this — both reads are sync and small. Consider memoizing across the process via the existing `_resetConfInstance()` pattern if perf becomes an issue post-R02.

#### 8.6.3 `email` source for `config resolve` when no profile is set
The `email` field is not part of `PartialAppConfig` — it lives on `AppConfig` after `resolveCredentials` runs. `config resolve` deliberately does NOT call `resolveCredentials` (no HTTP, no token read). It reads `email` directly from `store.profiles[currentProfile].email` if available, else `""` with `source: 'default'`. This is documented in `src/config/resolve-data.ts`'s JSDoc.

#### 8.6.4 The `config use` mock-fetch assertion
The test file `test/commands/config/use.test.ts` asserts no HTTP traffic. We cannot directly assert "no `fetch` was called" without mocking undici. The simplest path: do not register any MSW handler and assert the test completes without a network-error throw. (R01 already configures `msw` in `test/setup.ts` to error on unhandled requests.) This is a positive test by absence — implementer should add an explicit comment.

#### 8.6.5 Schema-bump compatibility on a v2 store read by a downgraded CLI
Per §5, this throws `corrupt-config` exit 1. We accept this; document in the changeset that downgrades aren't supported. No code change required.

---

