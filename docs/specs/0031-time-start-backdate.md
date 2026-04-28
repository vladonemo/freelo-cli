# Spec 0031 — `freelo time start --at <ISO>` (backdate, queued)

**Status:** Draft
**Owner:** orchestrator (run `2026-04-28-2050-r19.5-time-start-backdate`)
**Roadmap:** R19.5
**Date:** 2026-04-28
**Depends on:** R19 (spec 0030)

## 1. Problem

R19 shipped `freelo time start [--task <id>] [--note <str>] [--dry-run]` with the implicit assumption that the server-side start timestamp is "now". That assumption is wrong in two real-world flows:

1. **Forgot to start the timer.** A user starts work at 09:00, remembers at 09:42, runs `freelo time start --task 4567`. The session shows 0 minutes elapsed even though 42 minutes have actually passed.
2. **Replayed integration event.** A bot watches Jira / Trello / a CI system; when a ticket moves to "in progress" the bot fires `freelo time start`. If the event arrives after a delay (queue lag, a re-driven webhook), the timer should reflect the actual transition time, not the bot's wall clock.

Freelo's API already supports this: `POST /timetracking/start` accepts an optional `date_reported` body field that backdates the session start (`docs/api/freelo-api.yaml:2744`). R19 simply didn't surface it as a CLI flag.

## 2. Proposal

### 2.1 CLI surface (additive over R19)

```
freelo time start --task <id> [--note <str>] [--at <ISO>] [--dry-run]
```

The new flag is `--at <ISO>`. Everything else from R19 is unchanged.

- `--at` is **optional**. When omitted, behavior is identical to R19 (server defaults to "now").
- `--at` accepts any value `Date.parse()` accepts that resolves to a valid timestamp — both RFC 3339 / ISO 8601 timestamps (`2026-04-28T08:42:00Z`, `2026-04-28T10:42:00+02:00`) and the bare-date convenience form (`2026-04-28`, treated as midnight UTC).
- The CLI normalizes accepted input to canonical UTC `YYYY-MM-DDTHH:MM:SSZ` before sending — agents always see a single shape on the wire, which keeps fixtures and request logs diff-clean.
- Validation failures throw `ValidationError` (exit 2) with a `hintNext` pointing at `--at YYYY-MM-DDTHH:MM:SSZ`.

### 2.2 Wire mapping

The CLI `--at` flag maps to the wire body field `date_reported`:

```jsonc
// --at 2026-04-28T08:42:00Z
{ "task_id": 4567, "note": "...", "date_reported": "2026-04-28T08:42:00Z" }

// --at 2026-04-28T10:42:00+02:00 (normalized to UTC)
{ "task_id": 4567, "note": "...", "date_reported": "2026-04-28T08:42:00Z" }

// --at omitted — `date_reported` MUST be absent (not null)
{ "task_id": 4567, "note": "..." }
```

**Wire-cleanliness rule:** when `--at` is omitted, the body MUST NOT carry `date_reported` at all — neither `null` nor `undefined`-serialized-as-null. This keeps wire diffs against R19 fixtures empty for the unchanged path. Implemented by a conditional spread in `buildStartTimerBody` — same pattern already used for `task_id` and `note`.

### 2.3 Output schema — UNCHANGED (`freelo.time.start/v1`)

The envelope `data` shape and schema string both stay identical to R19:

| field   | type           | always present | notes                                              |
| ------- | -------------- | -------------- | -------------------------------------------------- |
| `uuid`  | string         | live only      | server-side UUID                                   |
| `task_id` | int \| null  | yes            | echo of `--task` (null when omitted)               |
| `note`  | string \| null | yes            | echo of `--note` (null when omitted)               |
| `would` | object         | dry-run only   | `{ method, path, body }` — body now MAY carry `date_reported` |

**No `--at` echo on the live `data`.** The flag's effect is captured by the server's response (and by `data.would.body.date_reported` on dry-run); a live echo would mean rebuilding canonicalization-versus-server-roundtrip semantics on output, which the next slice (R20 `time stop` / `time edit`) doesn't need. Agents that want to confirm the backdate took effect run `freelo time status` and read `started_at`.

This is the central reason the schema **does not bump to /v2**: the change is purely on **input**, and the output contract is intact.

### 2.4 Validation rules

#### 2.4.1 ISO 8601 acceptance shape (decision 1)

Accept any `--at <s>` such that `!Number.isNaN(Date.parse(s))`. Convert via `new Date(s).toISOString()` to canonical UTC `YYYY-MM-DDTHH:MM:SS[.mmm]Z`. Then strip milliseconds (Freelo's existing wire field does not carry them) — emit the second-precision shape `YYYY-MM-DDTHH:MM:SSZ`.

Why not the existing `parseDateFlag` from `tasks create`? That helper is **date-only** (`YYYY-MM-DD` regex, midnight-UTC concatenation) and re-using it would forbid hour-of-day backdating, which is the whole feature. New helper `parseAtFlag` lives in `src/lib/iso-timestamp.ts` (new file) and is reusable for any future timestamp flag.

#### 2.4.2 Clock-skew clamp on futures (decision 2)

Reject any `--at` whose normalized UTC instant is **more than 60 seconds after `Date.now()`**. Errors as `ValidationError` (exit 2) with hint `Use a UTC ISO 8601 timestamp not in the future, e.g. --at YYYY-MM-DDTHH:MM:SSZ. Check your system clock if this looks wrong.`

Rationale: a "future" backdate is meaningless for a session that is being started right now. 60 s buffer accommodates harmless clock skew between a CI runner and the user's laptop. Anything beyond that is almost certainly a typo or a clock bug, and we'd rather fail early than confuse the server.

#### 2.4.3 No client-side lower bound (decision 3)

Do not impose a "no more than N days ago" sanity check. Mirror Freelo's server-side validation — if Freelo returns 400/422 for a too-far-back timestamp, surface it as `FreeloApiError` (exit 4) with the server's message. The roadmap explicitly says: "Mirror whatever Freelo's server-side validation does, don't invent stricter rules."

Concretely: a 1970 backdate should reach the server. If Freelo accepts it (likely yes — the API is permissive), the CLI accepts it. If Freelo rejects it, the CLI relays the rejection.

### 2.5 Dry-run interaction

`--dry-run` already works (R19). When `--at` is **also** passed:

- `data.would.body.date_reported` carries the canonicalized UTC string.
- `data.would.body` does NOT carry `date_reported` when `--at` is omitted.
- Live `data` is unchanged in either case.

The dry-run envelope's `data.task_id` / `data.note` / `data.would.method` / `data.would.path` are all unchanged from R19.

### 2.6 Help text

```
Options:
  --task <id>      Optional task id to associate with the session. Omit for general (taskless) work.
  --note <str>     Optional note attached to the session.
  --at <ISO>       Optional UTC ISO 8601 start timestamp (backdate). Defaults to "now" on the server.
                   Accepts dates with timezone offsets and bare YYYY-MM-DD; normalized to UTC before sending.
  --dry-run        Skip the POST; envelope echoes the body that would have been sent.
```

### 2.7 Examples

```
# Live backdate to 09:00 today, UTC:
$ freelo time start --task 4567 --at 2026-04-28T09:00:00Z --output json
{"schema":"freelo.time.start/v1","data":{"uuid":"...","task_id":4567,"note":null}, ...}

# Local time, normalized to UTC:
$ freelo time start --task 4567 --at 2026-04-28T11:00:00+02:00
# Wire body: { "task_id": 4567, "date_reported": "2026-04-28T09:00:00Z" }

# Dry-run echoes the canonical body:
$ freelo time start --task 4567 --at 2026-04-28T09:00:00Z --dry-run --output json
{"schema":"freelo.time.start/v1","dry_run":true,"data":{"task_id":4567,"note":null,
  "would":{"method":"POST","path":"/timetracking/start",
           "body":{"task_id":4567,"date_reported":"2026-04-28T09:00:00Z"}}}}

# Validation: malformed → exit 2:
$ freelo time start --at "not a date"
# stderr: { "schema":"freelo.error/v1", "error": { "code":"VALIDATION_ERROR", ... } }
# exit code: 2

# Validation: clock-skew future → exit 2:
$ freelo time start --at 2099-01-01T00:00:00Z
# stderr: VALIDATION_ERROR — too far in the future. exit 2.

# Server rejects far-past (if it does — mirrors server, doesn't pre-empt):
$ freelo time start --at 1970-01-01T00:00:00Z
# Whatever the server says — likely 400 → FREELO_API_ERROR exit 4.
```

## 3. Data model

### 3.1 New file: `src/lib/iso-timestamp.ts`

```ts
import { ValidationError } from '../errors/validation-error.js';

const FUTURE_SKEW_MS = 60_000;

/**
 * Parse a CLI flag value as a permissive ISO 8601 / RFC 3339 timestamp and
 * canonicalize to UTC `YYYY-MM-DDTHH:MM:SSZ` (second precision, no millis).
 *
 * Accepts any value `Date.parse()` accepts: full timestamps with offsets,
 * bare `YYYY-MM-DD`, and Date#toISOString shapes.
 *
 * Rejects:
 *   - inputs that don't parse → `ValidationError`
 *   - inputs more than 60 s in the future → `ValidationError` (clock-skew clamp)
 *
 * `now` is parameterized for deterministic testing.
 */
export function parseIsoTimestampFlag(
  label: string,
  raw: string,
  now: number = Date.now(),
): string {
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    throw new ValidationError(
      `${label} must be an ISO 8601 / RFC 3339 timestamp.`,
      { hintNext: `Use ISO 8601 in UTC, e.g. ${label} YYYY-MM-DDTHH:MM:SSZ.` },
    );
  }
  if (t - now > FUTURE_SKEW_MS) {
    throw new ValidationError(
      `${label} is in the future.`,
      {
        hintNext: `Use a UTC ISO 8601 timestamp not in the future, e.g. ${label} YYYY-MM-DDTHH:MM:SSZ. Check your system clock if this looks wrong.`,
      },
    );
  }
  // Canonicalize to second precision UTC.
  const iso = new Date(t).toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
  return `${iso.slice(0, 19)}Z`;
}
```

### 3.2 `src/api/schemas/time.ts` — additive

Extend the wire body type only (no public schema change):

```ts
export type StartTimerBody = {
  task_id?: number | null;
  note?: string | null;
  date_reported?: string;   // NEW — canonical UTC ISO when set; absent otherwise.
};
```

There is no `StartTimerBodySchema` — the body is built and shipped by `buildStartTimerBody`; only the **response** is validated by `TimeStartResponseSchema`. So this is a pure type change in `src/api/time.ts`.

### 3.3 `src/api/time.ts` — `buildStartTimerBody` extension

```ts
export type StartTimerInput = {
  taskId?: number;
  note?: string;
  dateReported?: string;   // NEW — canonical UTC ISO from parseIsoTimestampFlag.
};

export function buildStartTimerBody(input: StartTimerInput): StartTimerBody {
  const body: StartTimerBody = {};
  if (input.taskId !== undefined) body.task_id = input.taskId;
  if (input.note !== undefined) body.note = input.note;
  if (input.dateReported !== undefined) body.date_reported = input.dateReported;
  return body;
}
```

The `if (... !== undefined)` guards keep the spread idiom and produce wire-clean bodies — no `date_reported: null`, no `date_reported: undefined`, no key when not set.

### 3.4 `src/commands/time/start.ts` — flag + plumbing

Add the flag and wire it through both branches:

```ts
type StartOpts = {
  task?: number;
  note?: string;
  at?: string;            // NEW — already parsed/normalized by parseAtFlag.
  dryRun?: boolean;
};

// In registerStart:
.option(
  '--at <iso>',
  'Optional UTC ISO 8601 start timestamp (backdate). Defaults to "now" on the server.',
  (raw) => parseIsoTimestampFlag('--at', raw),
)

// In the action:
const at = opts.at;
const body = buildStartTimerBody({
  ...(taskId !== undefined ? { taskId } : {}),
  ...(note !== undefined ? { note } : {}),
  ...(at !== undefined ? { dateReported: at } : {}),
});
```

The dry-run branch's `body` already contains `date_reported` when set (by way of `buildStartTimerBody`), so `data.would.body` reflects it automatically — zero changes to the dry-run code path.

## 4. Edge cases

| edge case                                              | handling                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `--at` omitted                                         | Body has no `date_reported` key (R19 wire-clean parity)                           |
| `--at 2026-04-28T09:00:00Z`                            | Sent as-is in canonical form                                                      |
| `--at 2026-04-28T11:00:00+02:00` (with offset)         | Normalized to UTC `2026-04-28T09:00:00Z`                                          |
| `--at 2026-04-28` (date-only)                          | Treated as `2026-04-28T00:00:00Z`                                                 |
| `--at "not a date"`                                    | `ValidationError` exit 2 with parse-error hint                                    |
| `--at <empty string>`                                  | Same — `Date.parse('')` is NaN → `ValidationError` exit 2                         |
| `--at 2099-01-01T00:00:00Z` (clock-skew future)        | `ValidationError` exit 2 with future-clock hint                                   |
| `--at <now+30s>` (within 60 s skew)                    | Accepted — server-side will deal                                                  |
| `--at 1970-01-01T00:00:00Z` (far past)                 | Accepted client-side; if server rejects → `FreeloApiError` exit 4 (no client-side bound, decision 3) |
| `--at` + `--dry-run`                                   | `data.would.body.date_reported` carries canonical value; no POST                  |
| `--at` + 409 (singleton conflict)                      | Hint rewriter unchanged — still enriches via `time status`                        |
| `--at` + 401 / 5xx                                     | Same as R19 — error path unchanged                                                |
| `--at` carries fractional seconds (e.g. `.500Z`)       | Stripped during canonicalization (second precision)                               |
| `--at` carries timezone abbreviation (`PST`)           | `Date.parse` is lenient on these; if it parses, accept; otherwise `ValidationError` |

## 5. Non-goals

- **No `--at` on `time edit`** (R20). R20 will need its own flag for backdating an in-flight session; that is its slice's call, not ours.
- **No `--at` echo on live envelope `data`**. See §2.3.
- **No envelope schema bump.** Output `freelo.time.start/v1` is unchanged.
- **No introspect golden update.** The introspect golden (`test/fixtures/introspect-golden.json`) only locks the `auth` / `config` / `help` subtrees — it doesn't include `time`. Verified by grep.
- **No `--at` validation against the `--note` length** or any other unrelated constraint.
- **No replacement of the existing `--due` parser.** `parseDateFlag` stays date-only; `parseIsoTimestampFlag` is the new timestamp-aware sibling.
- **No batch / `--ids` / `--stdin`.** R19 inherited "singleton-per-user precludes batch"; R19.5 inherits.

## 6. Open questions

None. All three open questions from the run brief are resolved in §2.4 (decisions 1-3 below).

## 7. Decisions made autonomously

### Decision 1 — New `parseIsoTimestampFlag` helper, not reuse of `parseDateFlag`

**Question:** Should `--at` reuse the existing `parseDateFlag` from `tasks create` / `tasks edit` / `tasks list` / `subtasks add` / `comments list`?

**Decision:** No. Introduce a new helper `parseIsoTimestampFlag` in `src/lib/iso-timestamp.ts`.

**Alternatives considered:**
- Reuse `parseDateFlag` as-is — rejected; it's `YYYY-MM-DD` only and would forbid hour-of-day backdating, which is the whole feature.
- Extend `parseDateFlag` to optionally accept timestamps via a `mode` arg — rejected; would add a footgun on the five existing call sites that all expect date-only semantics.
- Inline the logic in `time/start.ts` — rejected; R20 will likely reuse it for `time edit --at`.

**Rationale:** New helper, narrow surface, single-responsibility. The roadmap line said "reuse the date-parsing helper" but the actual semantics differ; keeping the existing date-only helper unchanged preserves five callsites' behavior and saves a refactor risk that isn't germane to R19.5.

### Decision 2 — 60 s clock-skew clamp on `--at` futures

**Question:** What's N in "refuse `--at` more than N seconds in the future"?

**Decision:** 60 seconds.

**Alternatives considered:**
- 0 seconds (strict) — rejected; harmless clock skew between machines is real.
- 5 minutes — rejected; too lenient; a 5-min-future timer makes no sense for a "just started" session.
- No clamp (let server decide) — rejected; the parent prompt explicitly recommended a clamp, and "future timer that just started" is a UX bug surface that's worth catching client-side before the server even sees it.

**Rationale:** 60 s is the smallest tolerance that comfortably accommodates NTP drift and integration replays without permitting nonsensical futures. Server-side will independently reject anything it deems invalid.

### Decision 3 — No client-side lower bound on `--at`

**Question:** Should the CLI reject `--at` more than e.g. 30 days in the past?

**Decision:** No client-side lower bound. Mirror server behavior: relay whatever Freelo says.

**Alternatives considered:**
- 30-day soft cap with `ValidationError` and a hint — rejected; invents stricter rules than the server.
- 30-day soft warning that still sends the request — rejected; we don't have a "warn" channel and adding one for one flag is yak-shaving.

**Rationale:** Roadmap text is explicit: "Mirror whatever Freelo's server-side validation does, don't invent stricter rules." The server's response handling (`FreeloApiError` with `httpStatus: 400/422`) is already in place from R19's HTTP error tests.

### Decision 4 — Live envelope `data` does NOT echo `--at`

**Question:** Should the live (post-POST) envelope `data` carry an echo field like `started_at` so agents can confirm the backdate took?

**Decision:** No. The envelope shape stays exactly as R19 (`uuid`, `task_id`, `note`).

**Alternatives considered:**
- Add `started_at` to the live `data` echoing `--at` (or "now" if omitted) — rejected; would either be a public-contract change requiring `/v2`, or an additive optional field that agents would have to defensively check for.
- Re-fetch `time status` post-start to enrich `data` — rejected; double network call on the hot path for a confirmation that agents who care can do themselves.

**Rationale:** Wave 3 already provides `freelo time status` with `started_at`. Agents that need confirmation chain `start` → `status`. Keeping the envelope at /v1 keeps the schema contract intact and avoids a /v2 bump for a flag-only addition.

### Decision 5 — Wire-clean: omit `date_reported` entirely when `--at` not passed

**Question:** Send `date_reported: null` (mirrors `task_id` / `note` nullability) or omit the key entirely when `--at` is absent?

**Decision:** Omit the key entirely. Spec-explicit (parent brief, hard constraint #1).

**Alternatives considered:**
- Always send `date_reported: null` for symmetry — rejected; (a) the parent brief explicitly forbids it, (b) the OpenAPI spec for `date_reported` is text-only and doesn't document `null` semantics, so the safer wire shape is "absent".

**Rationale:** Wire fixtures from R19 stay byte-identical for the unchanged path. Server's documented default ("defaults to 'now' if not provided") triggers off **absence**, not `null`.

### Decision 6 — `--at` value canonicalized to second-precision UTC before sending

**Question:** Forward the user's literal `--at` string as-is, or canonicalize to UTC?

**Decision:** Canonicalize via `new Date(t).toISOString().slice(0, 19) + 'Z'`.

**Alternatives considered:**
- Forward as-is (preserves user's tz offset on the wire) — rejected; mixed tz handling on the server side is a surprise vector; tests and fixtures get harder.
- Canonicalize but keep millis (`.500Z`) — rejected; the existing R19 status endpoint emits second-precision `date_reported` in its responses; matching that on the request side keeps round-trip diffs clean.

**Rationale:** One canonical wire shape is simpler for fixtures, agents, and Freelo's audit logs. Users can still pass any tz; the CLI does the right thing.

## Plan

### Branch

`feat/time-start-backdate` (from `main` @ `f508dfc`).

### Files to create

| Path                                         | Intent                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/lib/iso-timestamp.ts`                   | `parseIsoTimestampFlag(label, raw, now?)` — RFC3339/ISO8601 → canonical UTC; rejects future >60s. |
| `test/lib/iso-timestamp.test.ts`             | Unit tests for the helper: accept/reject, canonicalization, clock-skew, deterministic-now. |
| `.changeset/r19.5-time-start-backdate.md`    | `freelo-cli: minor` — new `--at` flag.                                            |

### Files to modify

| Path                                         | Change                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/api/time.ts`                            | Extend `StartTimerBody` (add `date_reported?: string`); extend `StartTimerInput` (`dateReported?: string`); extend `buildStartTimerBody` to emit it conditionally. |
| `src/commands/time/start.ts`                 | Add `--at <iso>` option using `parseIsoTimestampFlag`; thread `dateReported` through both dry-run and live builders. |
| `docs/commands/time-start.md`                | Add `--at` to flags table; add "Backdating sessions" section with examples; add validation rules subsection. |

### Files NOT modified (deliberately)

- `src/api/schemas/time.ts` — no schema change; only the type alias `StartTimerBody` lives in `src/api/time.ts`, which is where the change lives.
- `src/ui/human/time-start.ts` — live human-mode summary already says "Started timer …"; no `--at` echo (decision 4).
- `test/fixtures/introspect-golden.json` — `time` not in the golden's command set.
- `README.md` — autogen Commands block aggregates from per-command docs; no top-level command added or renamed. Will run `pnpm check:readme` to verify.

### New runtime dependencies

**None.** All needed primitives present.

### Test strategy

#### Unit tests (`test/lib/iso-timestamp.test.ts`) — new

- Accepts `2026-04-28T09:00:00Z` → returns `2026-04-28T09:00:00Z`.
- Accepts `2026-04-28T11:00:00+02:00` → returns `2026-04-28T09:00:00Z` (UTC normalize).
- Accepts `2026-04-28` (date-only) → returns `2026-04-28T00:00:00Z`.
- Accepts `2026-04-28T09:00:00.500Z` → returns `2026-04-28T09:00:00Z` (millis stripped).
- Rejects `not a date` → `ValidationError`, hint mentions `--at`.
- Rejects empty string → `ValidationError`.
- Rejects `2099-01-01T00:00:00Z` with `now=Date.parse('2026-04-28T00:00:00Z')` → future-clamp `ValidationError`.
- Accepts `now + 30s` (within 60 s skew).
- Rejects `now + 61s` (just outside skew) → future-clamp `ValidationError`.
- Custom `label` propagates into error message + hint.

#### Integration tests (`test/commands/time/start.test.ts`) — extend existing file

New cases (added at the end of the existing describe blocks where natural):

- **`--at` happy path live**: `--task 4567 --at 2026-04-28T09:00:00Z` →
  - exit 0
  - wire body via `startOkWhenBody` predicate captures `{ task_id: 4567, date_reported: '2026-04-28T09:00:00Z' }` (no `note` key).
  - envelope shape unchanged from R19.
- **`--at` UTC normalization**: `--task 4567 --at 2026-04-28T11:00:00+02:00` →
  - wire body's `date_reported` is `2026-04-28T09:00:00Z`.
- **`--at` + `--dry-run`**: `--task 4567 --at 2026-04-28T09:00:00Z --dry-run` →
  - exit 0, `dry_run: true`, `data.would.body.date_reported === '2026-04-28T09:00:00Z'`.
- **No `--at` ⇒ no `date_reported` on the wire**: existing wire-body test should still pass; add an explicit assertion that the captured body has `date_reported` undefined when `--at` is absent.
- **No `--at` ⇒ no `date_reported` on the dry-run body**: existing dry-run test extended with `expect('date_reported' in env.data.would.body).toBe(false)`.
- **Validation: malformed `--at`**: `--at 'not a date'` → exit 2.
- **Validation: empty `--at`**: `--at ''` → exit 2.
- **Validation: `--at` future**: `--at 2099-01-01T00:00:00Z` → exit 2.
  (This relies on real `Date.now()` being well before 2099. Safe.)

#### Coverage callouts

- Calibration §1 — full test phase before commit.
- Calibration §2 — every error-class path has an explicit `exitCode` assertion: malformed `--at` (2), empty `--at` (2), future `--at` (2). The unit tests independently verify the `ValidationError`'s `hintNext` text.
- Calibration §3 — gates run on the committed tree before push (the five-step gate).
- Calibration §4 — no new `try/catch` in either `time/start.ts` or `iso-timestamp.ts`; the helper throws straight up to Commander's option parser, which routes through the existing `handleTopLevelError`.

### Five-gate before push

`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme` must all pass on the committed tree before `git push -u`.

### Rollout

Single landable slice. Squash on PR merge:

`feat(commands): r19.5 — freelo time start --at <ISO> (backdate via date_reported)`

### Decision-log links

Decisions 1-6 captured in §7 above.
