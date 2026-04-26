# Triage — R05.5 Hardening

**Run:** `2026-04-26-1848-r05-5-hardening`
**Tier:** **Yellow**

## Rationale

- Touches `src/errors/handle.ts` (cross-cutting error path) — Yellow trigger.
- Touches a public schema (`CurrencySchema`) — but loosening `z.string()` to
  `z.union([z.string(), z.number()]).transform(v => String(v))` is
  **backwards-compatible**: existing agents that pinned to string still
  see strings on the wire; the input parser now also accepts numbers from
  the live API.
- No auth, HTTP-defaults, retry, redirect, or release-tooling changes →
  no Red triggers.
- No new commands, no new flags, no new envelope schemas → no
  user-visible surface change beyond a patch-level bug fix.
- No new dependencies. No security-review trigger.
- Changeset will be `freelo-cli: patch` (three bug fixes, no behavior
  change for valid inputs).

## Pre-approved deps

None needed.

## Route flags

- `needsSecurityReview`: false — no auth/HTTP/secret-storage surface.
- `requiresFreeloApi`: false — local fixes only; MSW-driven tests.
- `windowsMatrixSubprocessTest`: **true** — Bug #3 regression must spawn
  the CLI as a subprocess on the Windows matrix row and assert that
  stderr does not contain `UV_HANDLE_CLOSING` or `Assertion failed:`.

## Pause-worthy escalations

- If architect concludes Bug #3 needs an architectural change (per-request
  agent vs. global dispatcher; different transport for pino-pretty;
  switching to `Agent.destroy()` in a way that breaks in-flight retries) →
  escalate to **Red**, pause.
- If the Windows-matrix subprocess test fails to reproduce the bug on
  CI but does on the user's machine → pause.
