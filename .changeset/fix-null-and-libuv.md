---
'freelo-cli': patch
---

Fix `freelo projects list` against real Freelo accounts on Windows.

- Schema parser now tolerates `null` on every optional field of project
  response schemas (Freelo returns `client: null`, `tasklists: null`, etc.,
  alongside absent fields). Inbound parser only — envelope schema
  `freelo.projects.list/v1` is unchanged. Repo-wide policy added: every
  optional API response field is also nullable.
- Top-level error handler now drains undici's global dispatcher before
  `process.exit`, preventing a libuv `UV_HANDLE_CLOSING` assertion
  (`src\\win\\async.c:76`) on Windows when sockets are still being torn down.
