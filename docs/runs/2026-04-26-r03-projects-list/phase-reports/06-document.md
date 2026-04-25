# Phase 6 — Document

**Run:** 2026-04-26-r03-projects-list
**Status:** ok

## Files added

- `docs/commands/projects-list.md` — full per-command reference with two
  agent invocations + one human invocation, the scope mapping table, the
  mid-stream `--all` error protocol, exit-code table, and the schema
  commitment statement.

## Files modified

- `docs/getting-started.md` — appended a "Listing projects" section
  between the agent / human first-run blocks and the Auth reference,
  with a json envelope example and a pointer to ndjson streaming.
- `README.md` — autogen Commands block regenerated via `pnpm fix:readme`
  (now lists `projects` group with `freelo projects list`).

## CI gate

`pnpm check:readme` clean on the post-fix tree (verified end-to-end gate
suite).
