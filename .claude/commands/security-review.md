---
description: Phase 5 security audit. Required when the branch touches auth, config, HTTP client, or dependencies. Invokes the security-auditor agent.
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(pnpm:*), Read, Glob, Grep, WebFetch
---

You are running the **security audit** portion of Phase 5 in the SDLC defined in `.claude/docs/sdlc.md`.

## Trigger check

Before spawning the auditor, verify at least one is true:
- `git diff main...HEAD --name-only` includes `src/config/**` or `src/api/client.ts`
- `package.json` or `pnpm-lock.yaml` changed
- A new input source (env var, path, URL) was added

If none apply, tell the user a security review probably isn't needed and stop. They can still force it.

## What to do

1. Produce the diff scope.
2. Spawn the `security-auditor` agent with the diff and a pointer to its checklist.
3. Present findings grouped as **Critical / Medium / Informational / Verified**.
4. If anything is **Critical**, do not open a public issue. Flag it for private disclosure to the maintainer.

## Do not

- Apply fixes. The auditor reports.
- Disclose critical findings in public channels (issues, PR comments on open repos).
