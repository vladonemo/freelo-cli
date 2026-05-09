# Phase 2 — Spec

**Artifact:** `docs/specs/0053-r39-tasks-create-from-template.md` (467 lines).

**Agents:** orchestrator (assuming `architect` + `freelo-api-specialist` roles via direct OpenAPI lookup at `docs/api/freelo-api.yaml:2187-2253`).

**Open questions:** none. All 5 decisions resolved in §7 of the spec.

**Notable decisions logged in spec §7:**

1. Reconcile roadmap-vs-OpenAPI body-shape gap: add required `--source-task`, drop unsupported `--name`, rename roadmap's `--tasklist` to `--target-tasklist`, add parity flags `--target-project` / `--date-start` / `--worker` from spec 0047.
2. Flat-leaf shape (no parent subcommand tree).
3. Inline `rewriteApiHint` per command (no shared helper).
4. Path helper exposed for dry-run reuse.
5. `--worker` empty → omit `users_ids` from body.

**Plan included:** yes — appended as `## Plan` section.

**Coverage of calibration log items:**

- §1, §2, §3, §4 (the explicit R38 PR #96 finding) addressed in test strategy.
- §7 not applicable — non-destructive command, no TTY-prompt path.

**No pause triggered.**
