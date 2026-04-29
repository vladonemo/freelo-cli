# Triage — R27 `freelo files download`

**Run:** 2026-04-29-1826-r27-files-download
**Tier:** Yellow (with `client.ts` Yellow-with-asterisk and security review)

## Rationale

| Signal | Verdict |
|---|---|
| Auth / config / release tooling | NOT touched |
| New runtime dependencies | NONE expected (uses `node:fs`, `node:fs/promises`, existing `undici` via `fetch`) |
| Breaking change to envelope / exit / flag | NONE — all additive |
| Touches `src/api/client.ts` | YES (additive `requestBinary` method) — Yellow per spec 0037 decision 01 precedent |
| Security review needed | YES — writes to user-controlled path (path traversal, EEXIST, symlink) |
| Changeset | minor |

## Routes / flags

- `requiresFreeloApi`: yes (verify endpoint shape — done in §1.5 below: clean `application/octet-stream` stream, no redirect)
- `needsSecurityReview`: **yes** (path traversal / overwrite / symlink concerns)
- `preApprovedDeps`: [] (no new deps anticipated)

## API verification (done before architect)

`docs/api/freelo-api.yaml:3835-3865` — `GET /file/{file_uuid}`:
- Returns `200` with `application/octet-stream`, schema `string format: binary`.
- `Content-Type` derived from stored MIME (per docs prose).
- `Content-Disposition` carries the original filename (per docs prose).
- 404 if missing/deleted/no access.
- **No redirect** documented; binary stream is direct.

OpenAPI is sufficient — no pause required for API behavior.

## Risk-tier flags

- **client.ts touch is additive only** — same shape as R25's `requestMultipart` (separate method, no change to `request()` or its retry/error/auth logic). Spec 0037 decision 01 set the precedent that this is Yellow with PR-body callout. R27 follows.
- **Yellow gate**: orchestrator opens PR, stops; human reviews and merges.

## Decisions to be made by architect (not orchestrator)

1. EEXIST handling: refuse + `--force`, vs always-overwrite. Decide & log.
2. `--stdout` interplay with structured output (stderr fallback vs suppression).
3. Filename inference precedence: `--output-path` > `Content-Disposition` > `<uuid>` (or `<uuid>.bin` if no MIME hint).
4. Atomic write strategy: temp-in-target-dir + rename (vs anywhere-else + rename — cross-device hazard).
5. Streaming vs buffered: file size unknown; spec must commit.

## Pre-approved scope

Within budget (30 min / 40 calls / 25 files / 8 retries). No expansion of
scope without re-triage.
