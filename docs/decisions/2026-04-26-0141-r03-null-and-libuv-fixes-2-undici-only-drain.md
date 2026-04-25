# Decision 2 — Drain undici dispatcher only; defer pino/keytar

**Run:** 2026-04-26-0141-r03-null-and-libuv-fixes
**Phase:** Spec
**Agent:** orchestrator (architect)

**Question:** Should this run also drain pino-pretty and keytar handles?
**Decision:** No — undici only.
**Alternatives considered:**
- Drain all known async handles defensively. More code, more test surface,
  more risk of blocking.
- Add a generic shutdown registry. Over-engineered for a one-line bug fix.
**Rationale:** Pino-pretty is loaded as a transport function in-process, not
as a worker thread; pino destination uses `sync: false` but writes to a
file descriptor in-process. Neither matches the Windows libuv class of bug
(which fires on cross-thread async-handle teardown). Keytar is idle by
error-time. The user's report shows undici sockets — that's what we fix.
If pino later turns out to be a problem on Windows, we patch in a follow-up.
