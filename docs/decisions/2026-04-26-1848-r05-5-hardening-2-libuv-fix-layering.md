# Decision 2 — Windows libuv exit fix layering

**Run:** 2026-04-26-1848-r05-5-hardening
**Phase:** Spec
**Agent:** orchestrator (architect role)

**Question:** The 0.5.1 `dispatcher.close()` fix is incomplete. What's
the right next layer to add without going architectural (per-request
agents, transport rewiring)?

**Decision:** Three layered, low-risk changes:
1. Replace `dispatcher.close()` (graceful) with `dispatcher.destroy()`
   (forceful) on the error path.
2. Race `destroy()` against a 250 ms timeout using `Promise.race` — must
   not hang the CLI on exit.
3. Defer `process.exit` via `setImmediate` after `await drainDispatcher()`
   resolves — gives libuv one event-loop tick to finalize close
   callbacks.

**Alternatives considered:**
- `Promise.race(close, timeout)` only — does not address the
  synchronous-exit-after-await timing race that is the actual Windows
  bug.
- `setImmediate(exit)` only, no `destroy()` — marginally better than
  today; `close()` is already attempted but the real race is the
  synchronous exit timing.
- Switch to per-request `Agent` instances — architectural; would touch
  `src/api/client.ts` and every command; loses keep-alive across pages.
  Out of scope for a patch release.
- Remove pino-pretty from the error path — pino isn't in this hot path
  (the error envelope is written via direct `process.stderr.write`).
  Not the bug.

**Rationale:** Layered defenses. Each addresses a different half of the
race. Together they make the exit path safe on Windows without changing
behavior on macOS/Linux. The 250 ms timeout is generous — typical
`destroy()` resolves in <5 ms when nothing is in flight (and at error
time we have nothing in flight).

**Verifiability:** A unit test mocking `getGlobalDispatcher` proves
`.destroy()` is called and the call ordering is preserved. A subprocess
integration test on the Windows matrix row asserts the real condition:
zero `UV_HANDLE_CLOSING` strings in stderr after a forced zod failure
(per calibration log §1 — proxy assertions don't catch the bug).
