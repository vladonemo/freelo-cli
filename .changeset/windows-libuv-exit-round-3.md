---
'freelo-cli': patch
---

fix(errors): Windows libuv UV_HANDLE_CLOSING crash on the error-exit path (round 3)

The crash kept resurfacing after rounds 1 and 2 even with `dispatcher.destroy()`
plus a `setImmediate` hop. Empirically on Windows 11 + Node 24, it takes about
100 ms of wall-clock time after `dispatcher.destroy()` resolves before libuv
has finished closing its internal async handles. Phase rotation alone — even
50 `setImmediate` hops — does not clear it; only real time does.

`exitDeferred` now sets `process.exitCode = code` synchronously and schedules
`process.exit` via `setTimeout` with a 200 ms fallback (overrideable via
`FREELO_EXIT_DELAY_MS`). When the loop drains naturally before the fallback
fires (the common case after `dispatcher.destroy()` and a flushed envelope
write), the process exits cleanly with the right code and `process.exit` never
runs. Otherwise the fallback fires after libuv has had time to finalize.

The bug shipped because the integration test in
`test/integration/windows-libuv-exit.test.ts` uses a localhost HTTP stub —
which doesn't reproduce the production case (TLS to api.freelo.io leaves more
internal async handles mid-close at exit). A new unit test in
`test/errors/handle.test.ts` asserts the round-3 contract directly: that
`process.exitCode` is set before any `process.exit` call.

No public surface change — the `freelo.error/v1` envelope and exit codes are
identical.
