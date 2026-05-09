# Spec 0050 — `freelo tasks share` / `unshare` public link (R36, Wave 6)

**Status:** Draft
**Owner:** orchestrator (run `2026-05-09-1905-tasks-share`)
**Roadmap:** R36
**Date:** 2026-05-09
**Depends on:** R10 (`tasks edit`, spec 0020) — for the task-id parsing pattern; R13 (`tasks delete`, spec 0024) — for the destructive flow + idempotent-on-404 pattern; R35 (`tasks remind`, spec 0049) — for the sibling-pair structure and the "honest about wire ambiguity" idempotency pattern.

## 1. Problem

Freelo lets every task expose a **public, unauthenticated** URL that anyone holding the link can use to view the task read-only. The endpoints exist (`GET /public-link/task/{task_id}`, `DELETE /public-link/task/{task_id}` — `docs/api/freelo-api.yaml:2137-2185`); the CLI does not. Today an agent or shell script that wants to:

1. Hand a task to a client who has no Freelo account,
2. Embed the task in a status update or report,
3. Rotate a possibly-leaked link (DELETE then re-create),

…has to leave the terminal and click through the web UI. There's no programmatic surface.

The companion `tasks unshare` (revoke) is also missing. Without it, agent-driven sharing is one-way — once shared, never auto-rotatable.

## 2. Proposal

### 2.1 CLI surface (additive — two new sibling subcommands)

```
freelo tasks share <id> [--dry-run]
freelo tasks unshare <id> [--yes] [--dry-run]
```

Both are **single-id v1**. Two sibling top-level leaves under `tasks`, mirroring `tasks finish` / `tasks reopen` (R11) — not a parent-with-leaves like `tasks remind` (R35) — because there is no shared option surface to consolidate and the verbs differ in destructiveness.

**`tasks share <id>`** — non-destructive. Returns the task's public URL. Idempotent on the wire: the Freelo server creates a URL on first call and returns the same URL on subsequent calls (yaml :2150). The CLI surfaces this honestly — `created` is reported only when we can detect newness; on the live path we **cannot** distinguish "first call, just created" from "Nth call, returning existing", so `created: null`.

**`tasks unshare <id>`** — destructive. Revokes the public link, immediately invalidating any URL previously shared. Reuses the R13 `confirmDestructive` gate: `--yes` bypasses, TTY without `--yes` prompts, non-TTY without `--yes` throws `ConfirmationError` (exit 2). Idempotent: if the server returns 404 (no link existed), we re-classify as `already_in_target_state: true` (mirrors R13 / R35 spec 0049 §2.6).

### 2.2 Wire mapping

#### `share`

```
GET /public-link/task/{task_id}
(no body)
```

Response (yaml :2155-2165):

```jsonc
{ "url": "https://app.freelo.io/share/<opaque-token>" }
```

The OpenAPI spec documents this as `format: uri` and not explicitly `required:`. We treat it as required-string-on-200 — Freelo's contract for this endpoint is "either return a URL or fail", and the docstring reinforces this (yaml :2143). Schema is `.passthrough()` per the project convention.

> **Discrepancy with the roadmap line:** the roadmap (Wave 6, R36) says `POST /public-link/task/{task_id}`. The OpenAPI spec — which is authoritative per `.claude/CLAUDE.md` "Never guess API behavior. If `docs/api/freelo-api.yaml` doesn't answer the question, pause and ask `freelo-api-specialist`" — documents this as **GET** with explicit "GET that creates" semantics. The yaml answers the question; we follow it. See decision 1.

#### `unshare`

```
DELETE /public-link/task/{task_id}
(no body)
```

Response (yaml :2179-2185): `SuccessResponse` (`{ "result": "success" }`). The OpenAPI does not document the no-link-yet case behaviour, so we treat it as the R13 / R35 unknown-but-defensive-mapped: 404 → `already_in_target_state: true`; 200 → `already_in_target_state: false`.

### 2.3 Output schemas

Two new envelope schemas, one per leaf:

#### `freelo.tasks.share/v1`

| field         | type             | always present | notes                                                                                         |
| ------------- | ---------------- | -------------- | --------------------------------------------------------------------------------------------- |
| `task_id`     | int              | yes            | echo of `<id>` positional                                                                     |
| `url`         | string           | yes            | the public URL returned by the server (live) or a literal placeholder for dry-run (see §2.7) |
| `created`     | boolean \| null  | yes            | `null` on the live path (we can't tell — server collapses both cases); `null` on dry-run too. Field present so agents can assert key shape. |
| `would`       | object           | dry-run only   | `{ method: 'GET', path, body: {} }`                                                           |

#### `freelo.tasks.unshare/v1`

| field                       | type     | always present | notes                                                                              |
| --------------------------- | -------- | -------------- | ---------------------------------------------------------------------------------- |
| `task_id`                   | int      | yes            | echo of `<id>` positional                                                          |
| `already_in_target_state`   | boolean  | yes            | `true` on the defensive 404 path; `false` on a regular 200. Dry-run: `false`.      |
| `would`                     | object   | dry-run only   | `{ method: 'DELETE', path, body: {} }`                                             |

### 2.4 Validation rules

- `<id>` must be a positive integer. Rejected via `ValidationError` (exit 2) — not Commander's `InvalidArgumentError` (calibration §1-2).
- `share` does not accept `--yes` (non-destructive); the global `--yes` is silently ignored on this leaf (same as R35 `set`).
- `unshare` accepts the global `--yes` (destructive flow).
- Both accept `--dry-run`.

### 2.5 Confirmation policy (`unshare` only — `share` skips entirely)

Mirrors R35 `clear` / R13 `delete` byte-for-byte for the single-id flow:

- `--yes` → unconditional proceed.
- `--dry-run` → unconditional proceed (no destructive effect).
- TTY without `--yes` → prompt: `"Revoke public share link on task #<id>?"`. Decline → `ConfirmationError` (exit 2).
- Non-TTY without `--yes` → throw `ConfirmationError` (exit 2) immediately (fail closed).

Single-id only, so `confirmDestructive` is called once per invocation.

### 2.6 Idempotency

#### `share`

The Freelo `GET /public-link/task/{id}` returns `200` with the URL whether the link is brand-new or pre-existing (yaml :2150). The wire collapses both cases. We surface this honestly: `created: null` on the live path. Agents that need to know "did this call create or return an existing one" must track state externally (which is the same constraint Freelo's web UI has — they can't tell either).

`created` is included in the schema rather than omitted because:
- Future API versions may add a discriminator field; we want the slot reserved.
- A boolean-or-null is more discoverable than "sometimes the field is missing".
- Mirrors the R35 `clear` decision to surface `already_in_target_state` even when always `false` on the live path.

#### `unshare`

`DELETE` 200 → `already_in_target_state: false`. `DELETE` 404 → `already_in_target_state: true` (defensive — mirrors R13 spec 0024 §3.4 and R35 spec 0049 §2.6).

### 2.7 Dry-run behavior

Both leaves support `--dry-run`. In dry-run mode:

- No wire call.
- Envelope carries `dry_run: true`.
- `data.would.method`, `data.would.path`, `data.would.body` echo what would have been sent.

`share` dry-run has a special concern: there is no real URL to echo (we never called the server). We surface a deterministic placeholder that signals "this would have happened":

```
data.url = "<dry-run: not yet known>"
data.created = null
data.would = { method: 'GET', path: '/public-link/task/<id>', body: {} }
```

Agents inspecting a dry-run envelope can read `data.dry_run === true` (top-level) and know `data.url` is not a real URL. The placeholder is documented; tests assert it (no leakage of fake URLs).

`unshare` dry-run:

```
data.task_id = <id>
data.already_in_target_state = false
data.would = { method: 'DELETE', path: '/public-link/task/<id>', body: {} }
```

### 2.8 Help text

```
Usage: freelo tasks share [options] <id>

Get (or create) a public, unauthenticated URL for a task. Anyone holding
the URL can view the task read-only. Idempotent on the wire — first call
creates the link, subsequent calls return the same URL. To rotate, run
`tasks unshare <id>` then `tasks share <id>` again.

Options:
  --dry-run     Skip the GET; envelope echoes the path that would have been called.

---

Usage: freelo tasks unshare [options] <id>

Revoke the public share link on a task. Destructive — invalidates any
previously shared URL immediately. Requires --yes (non-TTY) or
interactive confirmation (TTY).

Options:
  --yes         Bypass the confirmation prompt (required in non-TTY mode).
  --dry-run     Skip the DELETE; envelope echoes the path that would have been called.
```

### 2.9 Examples

```bash
# Share a task (returns URL; idempotent on Freelo's side):
$ freelo tasks share 4567 --output json
{"schema":"freelo.tasks.share/v1","data":{"task_id":4567,"url":"https://app.freelo.io/share/abc123","created":null}}

# Dry-run echoes what would have been called:
$ freelo tasks share 4567 --dry-run --output json
{"schema":"freelo.tasks.share/v1","dry_run":true,"data":{"task_id":4567,"url":"<dry-run: not yet known>","created":null,"would":{"method":"GET","path":"/public-link/task/4567","body":{}}}}

# Revoke a share link (TTY, prompts):
$ freelo tasks unshare 4567
? Revoke public share link on task #4567? (y/N) y
{"schema":"freelo.tasks.unshare/v1","data":{"task_id":4567,"already_in_target_state":false}}

# Revoke (agent-style):
$ freelo tasks unshare 4567 --yes --output json
{"schema":"freelo.tasks.unshare/v1","data":{"task_id":4567,"already_in_target_state":false}}

# Defensive 404 (no link existed) → already_in_target_state: true
$ freelo tasks unshare 4567 --yes --output json
{"schema":"freelo.tasks.unshare/v1","data":{"task_id":4567,"already_in_target_state":true}}

# Validation: non-numeric <id>:
$ freelo tasks share abc
# stderr: VALIDATION_ERROR — <id> must be a positive integer. exit 2.

# HTTP error: 404 (task not found, distinct from defensive 404 on unshare):
$ freelo tasks share 9999
# stderr: FREELO_API_ERROR — Task not found. exit 4.
```

## 3. Data model

### 3.1 New file: `src/api/schemas/task-share.ts`

```ts
import { z } from 'zod';

/**
 * `GET /public-link/task/{task_id}` response (yaml :2155-2165).
 *
 * The OpenAPI documents `url` with `format: uri` but no explicit
 * `required:`. We treat it as required-string-on-200 — Freelo's contract
 * here is "200 carries the URL, anything else is an error response". Apply
 * the project-wide `.passthrough()` convention.
 */
export const ShareTaskResponseSchema = z
  .object({
    url: z.string(),
  })
  .passthrough();

export type ShareTaskResponse = z.infer<typeof ShareTaskResponseSchema>;

/**
 * `DELETE /public-link/task/{task_id}` response (yaml :2179-2185) — generic
 * `SuccessResponse`. Same shape as the R35 `clear` schema.
 */
export const UnshareTaskResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

/* ---- envelope `data` types -------------------------------------------- */

/** Wire echo for `--dry-run` envelopes. */
export type ShareWould = {
  method: 'GET' | 'DELETE';
  path: string;
  body: Record<string, unknown>;
};

/**
 * `freelo.tasks.share/v1` envelope `data`.
 *
 * - `task_id` — echo of `<id>` positional. Always present.
 * - `url`     — the public URL on the live path; a deterministic placeholder
 *               on dry-run. Always present.
 * - `created` — the wire collapses "first call (created)" and "Nth call
 *               (existing)" into a single 200; therefore `null` on every
 *               live path. Slot reserved for forward-compat. Always present.
 * - `would`   — present iff `--dry-run`.
 */
export type TasksShareData = {
  task_id: number;
  url: string;
  created: boolean | null;
  would?: ShareWould;
};

/**
 * `freelo.tasks.unshare/v1` envelope `data`.
 *
 * - `task_id`                 — echo of `<id>` positional. Always present.
 * - `already_in_target_state` — `true` only on the defensive 404 path.
 *                               `false` on the live 200 path. Always present.
 * - `would`                   — present iff `--dry-run`.
 */
export type TasksUnshareData = {
  task_id: number;
  already_in_target_state: boolean;
  would?: ShareWould;
};
```

### 3.2 New file: `src/api/tasks-share.ts`

Two thin wrappers + path helper, mirroring `src/api/tasks-reminder.ts`:

```ts
import { type ApiResponse, type HttpClient } from './client.js';
import {
  ShareTaskResponseSchema,
  UnshareTaskResponseSchema,
  type ShareTaskResponse,
} from './schemas/task-share.js';

export type ShareTaskOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type ShareTaskResult = {
  raw: ApiResponse<ShareTaskResponse>;
  body: ShareTaskResponse;
};

export type UnshareTaskOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type UnshareTaskResult = {
  raw: ApiResponse<unknown>;
};

export function publicLinkPath(taskId: number): string {
  return `/public-link/task/${taskId}`;
}

export async function shareTask(
  client: HttpClient,
  taskId: number,
  opts: ShareTaskOpts = {},
): Promise<ShareTaskResult> {
  const raw = await client.request({
    method: 'GET',
    path: publicLinkPath(taskId),
    schema: ShareTaskResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

export async function unshareTask(
  client: HttpClient,
  taskId: number,
  opts: UnshareTaskOpts = {},
): Promise<UnshareTaskResult> {
  const raw = await client.request({
    method: 'DELETE',
    path: publicLinkPath(taskId),
    schema: UnshareTaskResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
```

### 3.3 New files: `src/commands/tasks/share.ts`, `src/commands/tasks/unshare.ts`

Two standalone leaves under `tasks` (no parent), mirroring the `finish.ts` / `reopen.ts` sibling pair shape but **without** sharing a transition file (verb behaviour is too different).

### 3.4 New files: `src/ui/human/tasks-share.ts`, `src/ui/human/tasks-unshare.ts`

One-line human-mode renderers (TTY mode):

```
Public link for task #4567: https://app.freelo.io/share/abc123
[dry-run] Public link for task #4567 would be created at /public-link/task/4567.
Public link revoked on task #4567.
Public link on task #4567 was already revoked.   # if already_in_target_state
[dry-run] Public link on task #4567 would be revoked.
```

## 4. Edge cases

| edge case                                                  | handling                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `share <id>` first call (link created)                     | live envelope; `url` from server; `created: null` (wire ambiguous)                    |
| `share <id>` Nth call (link exists)                        | live envelope; same `url`; `created: null` (wire ambiguous)                           |
| `share` + 401                                              | `FreeloApiError` `AUTH_EXPIRED` (exit 3)                                              |
| `share` + 403                                              | `FreeloApiError` `FORBIDDEN` (exit 4)                                                 |
| `share` + 404 (task not found)                             | `FreeloApiError` `NOT_FOUND` (exit 4) — distinct from unshare 404                     |
| `share` + 5xx                                              | `FreeloApiError` (exit 4) — retryable                                                 |
| `share` + zod-fail (server returned no `url`)              | `FreeloApiError` `VALIDATION_ERROR` (exit 4) — wire contract violation                |
| `share` + `--dry-run`                                      | no wire call; `data.url = '<dry-run: not yet known>'`; `data.created = null`; `would.method = 'GET'` |
| `share <id>` with non-numeric `<id>`                       | `ValidationError` exit 2                                                              |
| `unshare <id>` + 200                                       | `already_in_target_state: false`                                                      |
| `unshare <id>` + 404                                       | `already_in_target_state: true` (defensive)                                           |
| `unshare` + 401                                            | `FreeloApiError` `AUTH_EXPIRED` (exit 3)                                              |
| `unshare` + 5xx                                            | `FreeloApiError` (exit 4)                                                             |
| `unshare` + non-TTY without `--yes`                        | `ConfirmationError` (exit 2) — no DELETE                                              |
| `unshare` + TTY without `--yes`, user declines             | `ConfirmationError` (exit 2) — no DELETE                                              |
| `unshare` + TTY without `--yes`, user accepts              | DELETE proceeds                                                                       |
| `unshare` + `--yes`                                        | DELETE proceeds, no prompt                                                            |
| `unshare` + `--dry-run`                                    | no DELETE, no prompt; `data.already_in_target_state: false`; `would.method = 'DELETE'` |
| `unshare <id>` with non-numeric `<id>`                     | `ValidationError` exit 2                                                              |
| stale URL after unshare                                    | not the CLI's problem — caller should re-share to rotate                              |

## 5. Non-goals

- **No batch (`--ids` / `--stdin`).** Single-id v1; revisit if demand emerges (R36.5).
- **No URL rotation as a single command.** Composable: `tasks unshare <id> --yes && tasks share <id>` is two calls. We do not bundle them — partial failure semantics get murky.
- **No envelope changes elsewhere.** No bumps to `freelo.tasks.show/v1`; no `public_url` field added to existing envelopes.
- **No copy-to-clipboard support** in TTY mode. The URL is in stdout; agents copy via `pbcopy` / `clip.exe` / `xclip` if they want.
- **No introspect golden update.** Verified by grep — `tasks` is in the golden, but the golden snapshots only specific subtrees. A fresh introspect run will be regenerated by `pnpm fix:readme` if the README autogen needs it.
- **No telemetry / analytics on shares.** Per CLAUDE.md: no telemetry without explicit opt-in.

## 6. Open questions

None. All decisions resolved in §7.

## 7. Decisions made autonomously

### Decision 1 — Use OpenAPI `GET` for share, not the roadmap's `POST`

**Question:** The roadmap says `POST /public-link/task/{task_id}`. The OpenAPI spec (`docs/api/freelo-api.yaml:2137-2152`) documents this as `GET` with explicit "GET that creates" semantics. Which is authoritative?

**Decision:** Use `GET` per the OpenAPI spec.

**Alternatives considered:**
- Implement as `POST` per the roadmap shorthand → rejected; would 404 (Freelo's actual server doesn't have this route as POST per the documented OpenAPI).
- Pause and ask the human to reconcile → rejected; the OpenAPI **does** answer the question (yaml :2137 explicit on the verb). The hard-rule "Never guess API behavior. If `docs/api/freelo-api.yaml` doesn't answer the question, pause" applies only when the yaml is silent — here it's explicit. The roadmap is a planning shorthand; the yaml is the contract.
- Implement both verbs → rejected; speculative; doubles surface.

**Rationale:** Per `.claude/CLAUDE.md` and `.claude/docs/autonomous-sdlc.md`: the OpenAPI is the authoritative source. The roadmap line is loose shorthand written before the API was inspected in detail. Following the yaml is consistent with how every prior R-line implemented its endpoints — cross-check yaml first, deviate only on documented behavior. The roadmap entry stays correct in spirit (the user surface is `share` / `unshare`); only the wire verb changes.

The "GET that creates" pattern is unusual (RESTful purists would have a POST), but it's what Freelo serves. The CLI wraps Freelo, not the Platonic ideal of REST.

### Decision 2 — `created` is always `null` on the live path

**Question:** Should `freelo.tasks.share/v1` carry a `created: boolean` field that reports whether this call created a new link or returned an existing one?

**Decision:** Carry the field, but make it `boolean | null` and set it to `null` on every live response. Reserve the slot for a future API version that adds a discriminator.

**Alternatives considered:**
- Omit the field entirely → rejected; agents would have to assume; future schema additions become breaking.
- Always `false` ("not created this call") → rejected; lies. We don't actually know.
- Always `true` ("link is now active") → rejected; lies in the other direction.
- GET pre-check: a HEAD on `/public-link/task/{id}` to see if a link exists, then GET → rejected; (a) Freelo doesn't document HEAD; (b) double round-trip on a non-destructive op for marginal info; (c) racy — link could be created between HEAD and GET.
- Parse the response body for a discriminator field → rejected; OpenAPI documents only `url`. Inventing semantics on undocumented body shape is forbidden by §autonomous-sdlc.

**Rationale:** Be honest about wire ambiguity (R35 spec 0049 decision 4 precedent). The slot is reserved so a future minor version (`/v2` if breaking, additive otherwise) can populate it without a schema bump. Type `boolean | null` makes the ambiguity explicit at the type level.

### Decision 3 — Two sibling top-level leaves (`share`, `unshare`), not parent + leaves

**Question:** R36 has two related verbs. R35 (`tasks remind`) put them under a parent (`tasks remind set`, `tasks remind clear`). R11 (`tasks finish` / `tasks reopen`) put them as siblings. Which shape for R36?

**Decision:** Siblings under `tasks` — `tasks share` and `tasks unshare`.

**Alternatives considered:**
- Parent + leaves: `tasks share-link create` / `tasks share-link revoke` → rejected; the verbs are simple enough that `share` / `unshare` reads naturally. Adds an unnecessary command level.
- One verb with a flag: `tasks share <id>` with `--revoke` → rejected; mixing destructive and non-destructive paths under one command is a UX foot-gun (calibration §2: error-class assertions get tangled).
- Parent: `tasks public-link <verb>` → rejected; verbose; hyphens in command names look odd next to single-word siblings.

**Rationale:** Sibling pair (R11 precedent) is the right shape when:
- The two verbs operate on the same noun but produce different surfaces (URL out vs. confirmation only).
- The destructiveness profile differs (one needs the `confirmDestructive` gate, the other doesn't).
- The roadmap line itself uses sibling verb names (`tasks share` / `tasks unshare`).

Parent-with-leaves (R35 precedent) is the right shape when the leaves share substantial option surface or are conceptually one operation in two modes.

### Decision 4 — Dry-run `share` returns a deterministic placeholder URL

**Question:** What goes in `data.url` when `--dry-run` is set on `share`?

**Decision:** A literal placeholder string: `"<dry-run: not yet known>"`.

**Alternatives considered:**
- Omit `data.url` on dry-run → rejected; the schema declares `url: string` always-present. Making it optional widens the type at runtime for a single edge case.
- Return `""` (empty string) → rejected; agents could confuse "empty" with "URL was empty"; less discoverable.
- Return `null` → rejected; same as omitting; widens the type.
- Construct a fake URL like `https://app.freelo.io/share/<dry-run>` → rejected; an agent might try to load it; surprising failure mode.

**Rationale:** A bracketed placeholder is unambiguous. It's parseable by humans and by agents (agents can match on the literal). The placeholder is documented in the spec, the help text, and the test suite. Tests assert the exact literal so it can't drift.

### Decision 5 — Defensive 404 mapping on `unshare` (R13 precedent reused)

**Question:** Should `unshare` re-classify a 404 as `already_in_target_state: true`, or surface it as `FreeloApiError`?

**Decision:** Re-classify as `already_in_target_state: true`. Same pattern as R13 `delete` and R35 `clear`.

**Alternatives considered:**
- Surface 404 as `FreeloApiError` → rejected; "deleting a thing that's already deleted" succeeding silently is the agent-friendly behavior. R13 / R35 precedent.
- GET pre-check before DELETE → rejected; double round-trip on destructive op (R13 / R35 precedent).
- Document the 404 case in OpenAPI then handle specifically → rejected; the OpenAPI is silent on the no-link case; we don't have authoritative behaviour to point to. The defensive map covers us if Freelo tightens the endpoint.

**Rationale:** Consistency across destructive idempotent ops. Agents can rely on "delete-of-already-gone returns success with `already_in_target_state: true`" as a CLI-wide invariant.

### Decision 6 — `share` does not use the `--yes` flag (silent ignore on this leaf)

**Question:** Should `share` require or accept `--yes`?

**Decision:** No. `share` is non-destructive (it returns a URL or creates one — it does not invalidate prior state). The global `--yes` is silently ignored.

**Alternatives considered:**
- Require `--yes` defensively → rejected; non-destructive ops do not need confirmation. Adds friction with no security benefit.
- Document silent-ignore in help → out of scope; matches R35 `set` precedent; not worth a help line.

**Rationale:** Confirmation gates exist to prevent destructive surprises, not to gate non-destructive metadata reads. The R35 `set` leaf established this precedent.

### Decision 7 — Single-id v1; no batch in this slice

**Question:** Should `share` / `unshare` support `--ids` / `--stdin`?

**Decision:** No. Single-id only.

**Alternatives considered:**
- Mirror `tasks delete` (R13) batch shape → rejected; speculative; the URL output for `share` would have to be an NDJSON-of-objects-with-url, which is fine but unrequested.
- Ship `unshare --ids` / `--stdin` only → rejected; asymmetric surface across the two siblings.

**Rationale:** Keep the slice small and landable. Roadmap line for R36 is single-id. R36.5 can add NDJSON-batch with both leaves at once if demand emerges.

## Plan

### Branch

`feat/tasks-share` (from `main`).

### Files to create

| Path                                                    | Intent                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/api/schemas/task-share.ts`                         | Zod response schemas for share/unshare + envelope `data` types.               |
| `src/api/tasks-share.ts`                                | `shareTask()` / `unshareTask()` / `publicLinkPath()` wire wrappers.           |
| `src/commands/tasks/share.ts`                           | `tasks share <id> [--dry-run]` leaf (non-destructive).                        |
| `src/commands/tasks/unshare.ts`                         | `tasks unshare <id> [--yes] [--dry-run]` leaf (destructive).                  |
| `src/ui/human/tasks-share.ts`                           | Human-mode renderer for `share`.                                              |
| `src/ui/human/tasks-unshare.ts`                         | Human-mode renderer for `unshare`.                                            |
| `test/commands/tasks/share.test.ts`                     | Integration tests for `tasks share` (MSW).                                    |
| `test/commands/tasks/unshare.test.ts`                   | Integration tests for `tasks unshare` (MSW + confirm helper).                 |
| `docs/commands/tasks-share.md`                          | User-facing docs for `share`.                                                 |
| `docs/commands/tasks-unshare.md`                        | User-facing docs for `unshare`.                                               |
| `.changeset/r36-tasks-share.md`                         | `freelo-cli: minor` — new subcommands.                                        |

### Files to modify

| Path                              | Change                                                                  |
| --------------------------------- | ----------------------------------------------------------------------- |
| `src/commands/tasks.ts`           | Import + call `registerShare` and `registerUnshare`.                    |
| `test/msw/handlers.ts`            | Append `tasksShareHandlers` and `tasksUnshareHandlers` blocks.          |
| `README.md`                       | Autogen Commands block — regenerate via `pnpm fix:readme`.              |
| `docs/roadmap.md`                 | Mark R36 as shipped (date + PR # appended after merge — done in PR commit, not pre-merge). |

### Files NOT modified

- `src/api/client.ts` — no client changes; reuses GET/DELETE.
- `src/api/schemas/task.ts` — no envelope shape change.
- `src/lib/confirm.ts` — reused as-is.
- `src/lib/dry-run.ts` — reused as-is.
- `src/ui/envelope.ts` — reused as-is.
- `test/fixtures/introspect-golden.json` — only specific subtrees are locked; verify by grep.

### New runtime dependencies

**None.** All needed primitives present.

### Test strategy

#### Integration tests (`test/commands/tasks/share.test.ts`) — new

Use MSW to mock `GET /public-link/task/4567`. Mirror the `tasks/remind-set.test.ts` shape.

- **Happy path live**: `share 4567` → exit 0, envelope `freelo.tasks.share/v1`: `{ task_id: 4567, url: '<server-url>', created: null }`.
- **Idempotent live**: server returns same URL on second call; CLI envelope is identical (no `created` change). (One test, single call; comment notes the wire idempotency.)
- **Dry-run**: `share 4567 --dry-run` → no wire call, envelope `dry_run: true`, `data.url = '<dry-run: not yet known>'`, `data.created = null`, `would.method = 'GET'`, `would.path = '/public-link/task/4567'`, `would.body = {}`.
- **Validation: non-numeric `<id>`** → exit 2.
- **Validation: zero `<id>`** → exit 2.
- **HTTP error: 401** → exit 3.
- **HTTP error: 403** → exit 4.
- **HTTP error: 404 (task not found)** → exit 4. (Distinguish from `unshare` 404 → success.)
- **HTTP error: 500** → exit 4.
- **Schema-violation (server returns `{}` with no `url`)** → exit 4 (`FreeloApiError`).
- **Human mode renders one line containing the URL.**

#### Integration tests (`test/commands/tasks/unshare.test.ts`) — new

Use MSW to mock `DELETE /public-link/task/4567`. Mirror the `tasks/remind-clear.test.ts` shape.

- **Happy path live + `--yes`**: `unshare 4567 --yes` → exit 0, envelope `{ task_id: 4567, already_in_target_state: false }`.
- **Defensive 404 → idempotent** → exit 0, `already_in_target_state: true`.
- **Dry-run**: `unshare 4567 --dry-run` → no wire call, envelope `dry_run: true`, `would.method = 'DELETE'`, `would.body = {}`.
- **Non-TTY without `--yes`** → exit 2 `CONFIRMATION_REQUIRED`, no wire call. (Calibration §7: clear `CI` env, spoof `isTTY = false`.)
- **TTY accepts** → exit 0; `confirmDestructive` gets `isInteractive: () => true`, prompt mock returns `true`. **Calibration §7: clear `CI`.**
- **TTY declines** → exit 2 `CONFIRMATION_REQUIRED`. **Calibration §7: clear `CI`.** Assert prompt copy contains `task #4567`.
- **Validation: non-numeric `<id>`** → exit 2.
- **Validation: zero `<id>`** → exit 2.
- **HTTP error: 401** → exit 3.
- **HTTP error: 500** → exit 4.
- **Human mode** renders "Public link revoked on task #4567" / "was already revoked" / "[dry-run] would be revoked".

#### Coverage callouts

- Calibration §1 — full test phase before commit.
- Calibration §2 — every error-class path has an explicit `exitCode` assertion: `ValidationError` (2), `ConfirmationError` (2), `FreeloApiError` (3 / 4).
- Calibration §3 — five-gate before push.
- Calibration §4 — the only new `try/catch` is in `unshare.ts` (defensive 404 → already-revoked); covered by mandatory test.
- Calibration §7 — TTY-prompt tests in `unshare.test.ts` clear `CI` env around the test body.

#### Five-gate before push

`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme` must all pass on the committed tree before `git push -u`.

### Rollout

Single landable slice. Squash on PR merge:

`feat(commands): tasks share / unshare public link (R36)`
