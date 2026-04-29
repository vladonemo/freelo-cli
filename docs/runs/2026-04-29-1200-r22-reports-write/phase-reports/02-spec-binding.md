# Phase 2 — Spec binding (partial; paused)

**Run:** 2026-04-29-1200-r22-reports-write
**Status:** **paused** before architect/freelo-api-specialist invocation
**Reason:** roadmap → OpenAPI verb divergence on the edit endpoint; invocation directive requires explicit pause.

## API surface bound against `docs/api/freelo-api.yaml`

### `POST /task/{task_id}/work-reports` (yaml :3045-3093)

- Body: `minutes` (int, required), `date_reported` (date, optional), `worker_id` (int, optional), `cost` (string, optional), `note` (string, optional).
- Wire format for `cost`: **string, "Currency amount (2 decimal places × 100)"** — i.e. cents-as-string. Example in OpenAPI: `"100025"` = 1000.25.
- Response: 200 → `WorkReport` (yaml :5669-5698): `id`, `date_add` (datetime), `date_reported` (date), `note?`, `minutes`, `cost (Currency)`, `author (UserBasic)`, `worker (UserBasic)`, `task ({id, name})`.
- Error notes: 400 `WorkReportCanNotBeCreatedException`, 400 `WorkerHasNoAccessToTasklistException` if delegating worker without rights.
- **Roadmap match:** ✅ verb POST agrees with roadmap.

### `POST /work-reports/{work_report_id}` — edit (yaml :3095-3143)

- **Verb is POST, not PATCH.** Same trap as R18 (comments edit) and R20 (`time edit`).
- Body (all optional): `minutes`, `cost`, `date_reported`, `note`, `task_id`.
- Response: 200 → `WorkReport`.
- ACL: only author / project owner / commander; others get NotFoundException (hide existence).
- **Roadmap match:** ❌ roadmap says `PATCH`. **Pause trigger.**

### `DELETE /work-reports/{work_report_id}` (yaml :3144-3171)

- Response: 200 → `SuccessResponse` (`{ result: "success" }`).
- ACL: only author or project admin; unauthorized → 400 with `UserCannotDeleteWorkReport` (note: 400, not 403).
- Idempotency on second-delete: **not documented in OpenAPI.** Need a fixture or a behavior decision. Likely 400 or 404; needs verification.
- **Roadmap match:** verb agrees, but second-delete behavior is undefined in spec.

## Money / cost encoding

OpenAPI confirms cost is **string, cents-as-int-stringified** (e.g. `"100025"` for 1000.25 of the worker's currency). The roadmap line for R22's CLI does **not** include a `--cost` flag — only `--minutes`, `--date`, `--note`. So:

- v1 CLI surface does **not** expose `--cost` → no money helper needed for log/edit input.
- The response `cost` field is rendered as-is via the existing `CurrencySchema` in `src/api/schemas/report.ts` (R21).
- **Decision:** defer `src/lib/money.ts` to a future slice that adds `--cost`. Log as decision after resume.

## Why pause now

The invocation explicitly states:
> Especially confirm: ... Whether `PATCH /work-reports/{id}` is the verb (vs POST — R18 had this trap with comments). ... If any of those contradict the roadmap line, **pause** and document the divergence, do not silently re-route.

Even though there is well-established precedent (R18 comments-edit, R20 time-edit) for autonomously adopting the OpenAPI verb and logging a decision, the invocation directive overrides general policy.

The second-delete idempotency behavior is the secondary pause input — the OpenAPI is silent, so per the autonomous-sdlc.md rule "API behavior not in `docs/api/freelo-api.yaml` → Pause (don't guess the API)".
