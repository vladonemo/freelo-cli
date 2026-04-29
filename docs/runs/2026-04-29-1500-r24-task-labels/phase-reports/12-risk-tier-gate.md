# Phase 12 — Risk-tier gate

**Tier:** Yellow → stop at PR for human review.

Per autonomous-sdlc.md: "Yellow — runs through PR, stops before merge".

Do **not** enable auto-merge. Human reviews PR #69 before merge.

## Why Yellow

- Three new user-visible subcommands (`task-labels create`, `attach`, `detach`).
- Three new envelope schemas (additive).
- No auth/config/HTTP-client/dependency changes.

## What's next

Human reviews PR. CI runs the matrix. After merge, R25 (`freelo files upload`) is the next roadmap slice.
