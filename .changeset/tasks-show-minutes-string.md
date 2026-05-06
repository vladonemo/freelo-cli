---
'freelo-cli': patch
---

fix(api): tolerate `minutes` as a wire string on `GET /task/{id}`

Live Freelo API returns `minutes` as a JSON string (e.g. `"130"`) on
`GET /task/{id}` for tasks with logged time, contradicting the OpenAPI
spec which types it as an integer. `freelo tasks show <id>` failed with
`VALIDATION_ERROR` whenever the task had any minutes logged.

`TaskDetailSchema.minutes` (and the nested `TimeEstimateSchema` /
`UserTimeEstimateSchema` that live on the same response) now accept
either string or number and coerce to a number. Same divergence pattern
as `CurrencySchema.amount`, which already handles wire-string amounts.

Other endpoints carrying a `minutes` field (`/work-reports`,
`/all-projects`, etc.) were probed live and consistently return numbers,
so their schemas are unchanged.
