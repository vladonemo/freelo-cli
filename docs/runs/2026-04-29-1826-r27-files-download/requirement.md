# Requirement — R27 `freelo files download`

Source: `docs/roadmap.md` lines 500-504.

> ### R27 — `freelo files download`
>
> **Endpoints:** `GET /file/{file_uuid}`.
> **CLI:** `freelo files download <uuid> [-o <path>] [--stdout]`.
> **Depends on:** R26.

## Context (from /auto invocation)

R25 (`files upload`) and R26 (`files list`) are merged. The `freelo files`
command group is wired in `src/commands/files.ts`; `src/api/files.ts` and
`src/api/schemas/file.ts` are in place. R27 adds the third subcommand under
the same group — a binary download.

This is the first command in the CLI that **streams a binary response body
to a file or stdout**. Treat that as a first-class design concern:
- Endpoint likely returns a binary stream (verified — `application/octet-stream`)
- `-o <path>`: write to file (atomic — temp + rename)
- `--stdout`: pipe to process stdout (must NOT corrupt JSON envelopes — when
  `--stdout` is given the user has explicitly chosen binary-on-stdout, so
  structured output goes to stderr or is suppressed)
- Default (neither flag): infer filename from response headers
  (`Content-Disposition`) or the UUID, write to CWD
- Spinner via `ora` only on TTY (lazy import)
- Schema validation does NOT apply to binary bodies — but envelope output
  (success metadata) still does
- Atomic writes, EEXIST handling

## Run config

- runId: `2026-04-29-1826-r27-files-download`
- Budget defaults: 30 min wall, 40 calls, 8 retries, 25 files
- `allowNetwork`: false — MSW only
- `autoShip`: false — never publish

## Pre-flight

- Working tree clean
- On `main` after R26 merge (HEAD `283f980`); orchestrator will branch fresh.
