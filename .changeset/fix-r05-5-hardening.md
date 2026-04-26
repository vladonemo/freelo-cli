---
'freelo-cli': patch
---

R05.5 hardening — three real-world bugs reproduced on `freelo-cli@0.7.0` and
`0.8.0` against a live Freelo account on 2026-04-26:

- **Schema:** `UserBasic.fullname` is now `.nullable().optional()`. Live
  Freelo can return user objects without a fullname (deleted users,
  externally-invited pending users, system actors). The strict schema
  rejected these payloads. Same defensive sweep extends to
  `WorkerWithHourRate.fullname` and `HourRate.{amount,currency,is_fixed}`.
- **Schema:** `Currency.amount` (used by `ProjectFull.real_cost`,
  `ProjectFull.budget`, `TasklistFull.budget`, `TasklistFull.real_cost`)
  now accepts both string and number. Live Freelo returns `amount` as a
  number on multiple endpoints; the prior `z.string()` rejected every
  affected response. The schema normalizes numeric input to a canonical
  string so the public envelope contract (`Currency.amount: string`)
  stays stable.
- **Errors:** Round-2 fix for the Windows libuv `UV_HANDLE_CLOSING`
  assertion on exit. The 0.5.1 `dispatcher.close()` fix was incomplete —
  on Windows it still tripped on any zod-validation failure exit. We now
  use `dispatcher.destroy()` (forceful) bounded by a 250 ms timeout race,
  and defer `process.exit` via `setImmediate` so libuv has one
  event-loop tick to finalize close callbacks before the synchronous exit.

No envelope schema bumps. Inbound parser is widened in all three cases;
output envelope is unchanged.
