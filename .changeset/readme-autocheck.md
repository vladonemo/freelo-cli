---
'freelo-cli': patch
---

Backfill `README.md` to reflect the commands shipped in 0.3.1 (auth login/logout/whoami,
config list/get/set/unset/profiles/use/resolve, plus `--introspect` and `help --output json`),
replacing the stale "early scaffold — only `freelo --version` exists" status line. The
Commands section is now generated from a live `freelo --introspect` envelope and verified
in CI by `pnpm check:readme` so it can never drift again.
