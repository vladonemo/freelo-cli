# Decision 2 — 204 No Content handling lives in src/api/client.ts (additive)

**Run:** `2026-04-28-1628-r19-time-start-status`
**Phase:** Spec / Implement
**Agent:** orchestrator (architect role)

**Question:** Where to handle the 204 No Content body returned by `GET /timetracking/status`? The shared `HttpClient.request` always calls `response.json()` on 2xx, which throws on an empty body.

**Decision:** Extend `client.request` with a short-circuit before the 2xx JSON parse:

```ts
if (response.status === 204) {
  const parsed = schema.safeParse(null);
  if (!parsed.success) throw FreeloApiError(VALIDATION_ERROR, ...);
  return { data: parsed.data, rateLimit, requestId };
}
```

This is the only diff to `client.ts`. Existing tests stay green because no current schema accepts `null`. The status schema is a `z.union([z.null(), <session>])`.

**Alternatives considered:**
- Bypass `client.request` for `time status` and call `fetch` directly in `src/api/time.ts` — rejected; would lose 401, 4xx, rate-limit, and abort handling that all routes through the shared client.
- Add an `allowEmpty: true` option to `request()` — rejected; YAGNI given grep on `docs/api/freelo-api.yaml` for `204:` returns only `/timetracking/status`. Easy to introduce later if a second 204 endpoint shows up.
- Map 204 to `FreeloApiError` and have the leaf catch — rejected; "no timer running" is a normal state, not an error. The taxonomy reserves `FreeloApiError` for actual failures.

**Rationale:** The `null`-accepting schema is the natural carrier for "no body". The change is fully additive — no existing schema accepts `null`, so no caller behaviour changes. Tier stays Yellow; no auth, retry, redirect, or rate-limit logic touched.
