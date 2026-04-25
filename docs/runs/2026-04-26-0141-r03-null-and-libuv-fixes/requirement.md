# Requirement — R03 null + libuv fixes

Real-world bug report from `freelo-cli@0.5.1` user running `freelo projects list`
on Windows. Two distinct bugs:

1. **Schema rejects `null` for optional complex fields** — `client: null` from
   the live Freelo API rejected by `ClientSchema.optional()`. Sweep all
   `.optional()` fields in `src/api/schemas/` and add `.nullable()` so the
   schema accepts both `undefined` (absent) and `null` (returned-as-null).
2. **Windows libuv crash on `process.exit()`** — undici's keep-alive socket
   pool not drained before exit; on Windows, libuv asserts
   `!(handle->flags & UV_HANDLE_CLOSING)`. Fix: `await
   getGlobalDispatcher().close()` before `process.exit` in
   `handleTopLevelError` and the SIGINT handler in `bin/freelo.ts`.

Budget: default (30m, 40 calls, 8 retries, 25 files).
Network: MSW only.
Risk tier: Yellow (cross-cutting error path; public envelope schema relaxed).

Branch: `fix/projects-list-null-and-libuv` off `main` (post `ea785c5`).
