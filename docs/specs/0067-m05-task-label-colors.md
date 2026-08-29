# 0067 — `freelo task-labels colors` (M05)

**Status:** Specified
**Run:** 2026-08-29-1750-m05-task-label-colors
**Roadmap:** `docs/roadmap-migration-2026-08.md` § M05
**Type:** feat
**Changeset:** `minor`
**Risk tier:** Yellow (PR stops for human review — no auto-merge)

---

## 1. Problem

R24.5 (spec 0048) added `--palette <name>` to every command that accepts a task-label colour. It
resolves nine canonical names to nine hex values from a **hardcoded, frozen table** in
`src/lib/label-color.ts`:

```ts
export const PALETTE: Readonly<Record<string, `#${string}`>> = Object.freeze({
  gray: '#77787A', aqua: '#15ACC0', blue: '#367FEE', green: '#10AA40', pink: '#CA3E99',
  purple: '#9235E4', red: '#E9483A', orange: '#F2830B', yellow: '#E3B51E',
});
```

That table was transcribed from Freelo's documentation at R24.5 time. Nothing in the CLI verifies it
is still what the server accepts. If Freelo adds a tenth colour, changes a hue, or retires one, the
CLI drifts silently: `--palette` keeps offering nine names, one of which may now snap to a different
colour on the server, and a newly-accepted colour is reachable only by someone who happens to know
its hex.

There is no way to ask the server what it actually accepts.

## 2. Proposal

A new read-only leaf:

```
freelo task-labels colors
```

No arguments, no flags beyond the global ones (`--output`, `-v`, `--request-id`, ...). One GET, one
envelope. It lists the palette the **server** accepts, marks which one is the server's create-time
default, maps each server colour back to the local `--palette` name where one exists, and reports
whether the local table still matches the server.

Human output (a `cli-table3` table via `renderTable`, lazy-loaded as usual):

```
COLOR     PALETTE   DISPLAY NAME   DEFAULT
#77787a   gray      Gray           yes
#15acc0   aqua      Aqua           -
#367fee   blue      Blue           -
...
```

JSON output is the envelope in §4.

### 2.1 What this command deliberately does not do

It does not change `--palette`, `--hex`, `PALETTE`, `resolveColorFlags`, or `paletteHelpBlock` in any
way. See §6 — that is the central design decision of this slice, and the answer is "alongside, not
replace".

## 3. API surface

**`GET /task-label-colors`** — `docs/api/freelo-api.yaml:2878-2896`.

The roadmap summary was treated as a hypothesis. Verified against the contract:

| Roadmap claim | Contract says | Verdict |
|---|---|---|
| Endpoint is `GET /task-label-colors` | `docs/api/freelo-api.yaml:2878`, `operationId: getTaskLabelColors` | **Confirmed** |
| "name + hex, if the response provides names; hex-only otherwise" | Response provides **both** — plus a third field the roadmap did not anticipate | **Confirmed, and under-stated** |
| (unstated) | Not paginated — no query parameters, no paging envelope, no `Link` header | **Confirmed absent** |

Response body (`yaml:2888-2896`):

```yaml
type: object
properties:
  colors:
    type: array
    items:
      $ref: '#/components/schemas/TaskLabelColor'
```

`TaskLabelColor` (`yaml:5960-5972`) — three fields, and the second one is decisive for §6:

```yaml
TaskLabelColor:
  type: object
  properties:
    color:
      type: string
      description: Hex value to send as the label color (e.g. "#15acc0").
    display_name:
      type: string
      description: Human-readable color name, for display only; not accepted as input.
    is_default:
      type: boolean
      description: True for the color applied when a label is created without a color.
```

### 3.1 Three contract findings the requirement did not carry

**(a) `display_name` is not accepted as input.** The contract is explicit: "for display only; not
accepted as input". The wire field for a colour is always `color: "#RRGGBB"` — as `TaskLabelAddInput`
(`yaml:5974-5990`) independently confirms. So the server does **not** expose a name-keyed input
vocabulary that the CLI could adopt. The CLI's `--palette gray` is, and can only be, a client-side
convenience that resolves to a hex before the wire call. This is the single most load-bearing fact in
the slice; §6 turns on it.

**(b) Hex case differs from the local table.** The contract's example is lowercase (`#15acc0`);
`TaskLabelAddInput` documents the default as lowercase `#77787a`; `PALETTE` stores uppercase
(`#15ACC0`). Every comparison between server and local values **must be case-insensitive** or the
command reports total drift on its first run against a perfectly current server. Triage flagged this
as open concern 3.

**(c) `is_default` is new information the CLI does not have today.** `TaskLabelAddInput` says colour
"defaults to `#77787a` if omitted", which is `PALETTE.gray` — but that is prose in a request schema,
not a value the CLI can read. `is_default` makes it machine-readable. Surfaced in the envelope.

### 3.2 Authentication

`GET /task-label-colors` sits under the same account-level security as every other Freelo endpoint —
there is no anonymous arm in the contract. A caller with no credentials gets 401, same as any other
command. This matters to §6: a live-fetch design would put an authenticated network call in front of
validation that is offline and free today.

## 4. Data model

### 4.1 Inbound (zod, `src/api/schemas/task-label.ts`)

```ts
export const TaskLabelColorSchema = z
  .object({
    color: z.string().nullable().optional(),
    display_name: z.string().nullable().optional(),
    is_default: z.boolean().nullable().optional(),
  })
  .passthrough();

export const TaskLabelColorsResponseSchema = z
  .object({ colors: z.array(TaskLabelColorSchema) })
  .passthrough();
```

Per the repo's permissive-schema policy (spec 0010, decision 1), every leaf is
`.nullable().optional()` and the object is `.passthrough()`. `colors` itself is **required** — a body
without the key is a contract violation and must fail loudly (`VALIDATION_ERROR`, exit 4). Same
posture as `FindAvailableTaskLabelsResponseSchema` (M04).

### 4.2 Outbound envelope — `freelo.task_labels.colors/v1`

```ts
export const TaskLabelsColorsEntrySchema = TaskLabelColorSchema.extend({
  palette_name: z.string().nullable(),
});

export const TaskLabelsColorsDataSchema = z.object({
  colors: z.array(TaskLabelsColorsEntrySchema),
  count: z.number().int().min(0),
  default_color: z.string().nullable(),
  drift: z.object({
    matches: z.boolean(),
    server_only: z.array(z.string()),
    local_only: z.array(z.string()),
  }),
});
```

- `colors[].palette_name` — the **local** `--palette` name whose hex equals this server colour
  (case-insensitive), or `null` when the server offers a colour the local table has no name for.
  Distinct from `display_name`, which is the *server's* label and per §3.1(a) is not typeable
  anywhere. `palette_name` answers "what do I type for `--palette`"; `display_name` does not.
- `default_color` — the `color` of the entry with `is_default: true`, or `null` if the server marks
  none. Lifted to the top level so a consumer does not have to scan the array.
- `drift.matches` — `true` when both `server_only` and `local_only` are empty.
- `drift.server_only` — server hexes with no local palette entry (a colour the CLI can only reach via
  `--hex`).
- `drift.local_only` — local palette **names** whose hex the server did not return (a name
  `--palette` still accepts that the server may no longer honour).

`count` mirrors the `count` carried by all four sibling `task_labels.*` envelopes. No `paging` — the
endpoint documents none (§3).

### 4.3 Pure helpers (`src/lib/label-color.ts`)

```ts
export function paletteNameForHex(hex: string | null | undefined): string | null;
export function comparePaletteToServer(
  serverColors: readonly (string | null | undefined)[],
): { matches: boolean; serverOnly: string[]; localOnly: string[] };
```

Both case-insensitive on hex. Pure, no I/O, unit-tested directly. They live next to `PALETTE` because
they are the only two functions that need to know its internal representation.

## 5. Edge cases

| Case | Behaviour | Exit |
|---|---|---|
| Server returns `{ "colors": [] }` | Empty table / `count: 0`, `default_color: null`, `drift.local_only` = all nine names, `matches: false` | 0 |
| No entry has `is_default: true` | `default_color: null` | 0 |
| More than one `is_default: true` | First wins (documented; the contract implies exactly one) | 0 |
| Server hex not in local table | `palette_name: null`, hex listed in `drift.server_only` | 0 |
| Local name absent from server | Listed in `drift.local_only` | 0 |
| Case mismatch only (`#15acc0` vs `#15ACC0`) | **Not** drift — comparison is case-insensitive | 0 |
| Body missing `colors` key | `ValidationError` / `VALIDATION_ERROR` | 4 |
| 401 | `FreeloApiError` (auth) | 3 |
| 5xx | `FreeloApiError` | 4 |
| 429 | `RateLimitedError` | 6 |
| Network failure | `NetworkError` | 5 |

No pagination, no rate-limit special-casing beyond the shared client, no partial failure (single
GET), no confirmation gate (read-only), no `--dry-run` (nothing to preview).

Drift is **data, not an error**. The command exits 0 whether or not the tables agree. Making drift a
non-zero exit would be a new exit-code contract and would push the slice toward Red for no gain — a
consumer that wants to fail a CI job on drift reads `.data.drift.matches`.

## 6. Design decision — replace vs. alongside

**Decision: alongside. The hardcoded `PALETTE` remains the sole, offline, authoritative validator for
`--palette`. This command is a discovery and drift-check surface, not a runtime dependency of any
existing flag.**

The roadmap recommended this. The recommendation was not inherited; it was re-derived, and the
OpenAPI contract turned out to make the case far more strongly than the roadmap's own reasoning did.
Full reasoning in `docs/decisions/2026-08-29-1750-m05-task-label-colors-2-palette-stays-local.md`.
The four arguments in brief:

1. **The server has no input vocabulary to adopt.** §3.1(a): `display_name` is explicitly "not
   accepted as input". A "replace" design cannot replace the name-to-hex mapping with a
   server-supplied one, because the server does not publish one for input. It would have to keep
   mapping `display_name` to `color` client-side and *hope* those display names stay stable and
   untranslated. Freelo is a Czech/Slovak product; a localised `display_name` would silently mutate
   the set of names `--palette` accepts based on account locale. That converts a deterministic,
   testable flag surface into a per-account, per-locale one. This alone is disqualifying.

2. **Fail-closed already has a first-class escape hatch, so its cost is near zero.** A stale local
   table fails *closed*: it rejects a colour the server now accepts. The recovery is one flag —
   `--hex #NEWHEX` — which is shape-validated only and passes straight to the wire, so **every**
   server colour, including ones added after this CLI version shipped, is already reachable today.
   Failing *open* (a live table accepting a name the server later rejects, or a cache serving a
   retired colour) has no equivalent hatch: it produces a server-side 400/422 after a round-trip, at
   write time, on the user's real data. Fail-closed with a documented one-flag workaround beats
   fail-open with a wire error.

3. **A live fetch would import network and auth failure modes into a path that has neither.**
   `resolveColorFlags` is pure, synchronous, offline, free, and its failure mode is a
   `ValidationError` the user can fix by reading the message. Fetching (§3.2 — authenticated) would
   make `freelo task-labels attach --palette red` capable of failing with 401, 429, a timeout, or a
   TLS error *before it ever tries to do the thing the user asked for*. A TTL cache does not remove
   that, it only makes it intermittent — and intermittent is worse to debug than never. The benefit
   bought by that cost is: the user can type a name for a colour they could already pass as `--hex`.

4. **Nine values that change roughly never do not warrant a cache-invalidation design.** The palette
   is described in the contract as "the fixed palette". A TTL cache means choosing a TTL, persisting
   it, deciding what happens on a cold cache in an offline agent, and testing all of it — a real
   chunk of state and failure surface, in service of a table that has been correct since R24.5.

**On the drift story specifically** (triage open concern 4): the roadmap's framing was "a way to
check the table is still current", i.e. a human runs it and reads a table. That is necessary but not
sufficient for the stated outcome, "the CLI stops silently drifting" — a human comparing two nine-row
tables by eye is exactly the process that let drift go unnoticed in the first place. So the envelope
carries the comparison (§4.2 `drift`) rather than leaving it to the reader. That makes the check
scriptable — `freelo task-labels colors | jq -e .data.drift.matches` is a one-line scheduled CI job —
**without** adding a flag, a mode, or an exit code. It is the minimum that makes the roadmap's stated
outcome real, and it is why this slice is worth more than a `curl`.

## 7. Non-goals

- **Changing `--palette` / `--hex` behaviour, or `PALETTE`'s contents.** §6. A behaviour change to an
  existing command would be a Red trigger and would pause this run.
- **A `--check` / `--verify` flag with a non-zero exit on drift.** Drift is in the envelope; a
  consumer can gate on it. A new exit-code contract is not free.
- **Caching the response.** No TTL, no on-disk cache, no state. One command invocation, one GET.
- **Auto-updating `PALETTE` from the server.** Codegen against a live API is out of scope and would
  need a network-enabled run.
- **`--project` scoping.** The endpoint takes no parameters (§3).
- **Reconciling the local table with whatever this command returns.** If a live run reveals real
  drift against production, that is a follow-up slice with its own spec — this one only makes the
  drift visible. This run is `allowNetwork: false`, so it cannot and does not check.

## 8. Open questions

None. The one open question the requirement carried (replace vs. alongside) is resolved in §6 on
contract evidence, and logged as decision 2.

---

## Plan

**No new dependencies.** No changes to `package.json`.

### Files

| File | Change | Intent |
|---|---|---|
| `src/api/schemas/task-label.ts` | modify | Add `TaskLabelColorSchema`, `TaskLabelColorsResponseSchema`, `TaskLabelsColorsEntrySchema`, `TaskLabelsColorsDataSchema` + inferred types (§4.1, §4.2). |
| `src/api/task-labels.ts` | modify | Add `TASK_LABEL_COLORS_PATH` and `getTaskLabelColors(client, opts)` returning `{ colors, raw }`; conditional `signal` / `requestId` spreads per convention. |
| `src/lib/label-color.ts` | modify | Add `paletteNameForHex` and `comparePaletteToServer` (§4.3). **`PALETTE`, `resolveColorFlags`, `paletteHelpBlock` untouched.** |
| `src/commands/task-labels/colors.ts` | **new** | The leaf. Modelled on `find.ts`: `meta`, `SCHEMA`, `register`, envelope, `handleTopLevelError`. No flags, no parsers. |
| `src/commands/task-labels.ts` | modify | `registerColors(taskLabels, ...)` as the fifth leaf. |
| `src/ui/human/task-labels-colors.ts` | **new** | Table renderer: `COLOR`, `PALETTE`, `DISPLAY NAME`, `DEFAULT`; plus a drift footer when `matches` is false. Async, lazy `cli-table3` via `renderTable`. |
| `test/msw/handlers.ts` | modify | `taskLabelsHandlers.colorsOk / colorsOkCapturing / colorsMalformed / colorsUnauthorized / colorsServerError / colorsRateLimited / colorsNetworkError`, mirroring the `find*` block. |
| `test/commands/task-labels/colors.test.ts` | **new** | End-to-end command tests (below). |
| `test/api/task-labels.test.ts` | modify | Wrapper test for `getTaskLabelColors` — explicit `signal` and `requestId` threaded through to `client.request` (both spread branches), per the conventions note from PR #96. |
| `test/lib/label-color.test.ts` | modify | Unit tests for `paletteNameForHex` / `comparePaletteToServer`, including the case-insensitivity guard. |
| `docs/commands/task-labels-colors.md` | **new** | User doc: two realistic examples, the drift-check recipe, the "why the local table is still authoritative" note, permissions. |
| `docs/commands/task-labels-find.md` | modify | One cross-reference line to the new command. |
| `README.md` | regenerate | `pnpm fix:readme` — autogen Commands block. |
| `.changeset/*.md` | **new** | `minor`; explicit line "schema `freelo.task_labels.colors/v1` added". |
| `docs/roadmap-migration-2026-08.md` | modify | Mark M05 shipped; **and the M02 heading bookkeeping fix** (separate commit). |
| `docs/specs/0067-m05-task-label-colors.md` | this file | — |
| `docs/runs/2026-08-29-1750-m05-task-label-colors/*` | new | requirement, triage, summary. |
| `docs/decisions/2026-08-29-1750-m05-*.md` | new | Decision log. |

### Test strategy

Unit (`test/lib/label-color.test.ts`):

- `paletteNameForHex` — exact match, case-insensitive match, unknown hex to `null`, `null` /
  `undefined` input to `null`.
- `comparePaletteToServer` — all nine present (uppercase input) gives `matches: true` and empty
  arrays; all nine present lowercase still gives `matches: true` (**the §3.1(b) guard**); server adds
  a tenth populates `serverOnly`; server omits one populates `localOnly` by name; empty server list
  puts all nine in `localOnly`; `null` entries in the server list are skipped, not crashed on.
- Regression guard: `PALETTE` still has exactly the nine R24.5 entries and `resolveColorFlags` is
  unchanged — the existing tests in this file already cover that and must keep passing untouched.

Unit (`test/api/task-labels.test.ts`): `getTaskLabelColors` threads `signal` and `requestId`
(both spread branches, `defined` and `absent`).

Integration (`test/commands/task-labels/colors.test.ts`), MSW, with a `warmUpCli()`-style `beforeAll`
so the first `await import` does not eat the 15s `testTimeout`:

- JSON envelope: `schema` string, `colors[]`, `count`, `default_color`, `drift`.
- `palette_name` populated for a known hex, `null` for an unknown one.
- Case-insensitive: a lowercase server payload matching all nine gives `drift.matches === true`.
- Drift both directions: extra server colour populates `server_only`; a missing one populates
  `local_only`.
- `default_color` lifted from `is_default`; `null` when no entry is flagged.
- Empty `colors: []` exits 0.
- Human output renders the table and the drift footer.
- Outbound path is exactly `/task-label-colors` with **no** query string (guards against wiring the
  sibling `/task-labels/find-available`). Assert request **content**, never counts — MSW resolvers
  fire twice per logical request in this repo.
- Exit codes (calibration §2): 401 gives 3, 5xx gives 4, malformed body gives 4, 429 gives 6, network
  gives 5.
- Introspect entry: `output_schema` present, `destructive: false`.

No TTY-prompt path in this command, so calibration §7's `CI`-clearing rule does not apply — human
output is driven via `--output human`, not TTY detection.

### Rollout order

One landable slice; two commits.

1. `feat(commands): freelo task-labels colors (M05)` — schema, api, lib helpers, command, renderer,
   tests, docs, README block, changeset, roadmap M05 entry.
2. `docs(roadmap): mark M02 tasklists edit shipped` — the bookkeeping fix, isolated so it is
   reviewable and revertable on its own.

### Gate order (calibration §3), on the clean committed tree

`pnpm typecheck && pnpm lint && pnpm test:cov && pnpm build && pnpm check:readme`
