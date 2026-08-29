# Requirement — M03 `freelo taskchecks` (simple checklist items)

**Run:** 2026-08-29-1046-m03-taskchecks
**Source:** `docs/roadmap-migration-2026-08.md` §M03 (merged to main in PR #112)
**Mode:** autonomous (`/auto`), `allowNetwork: false`, `autoShip: false`
**Base:** `main` @ 59a6d49 (verified clean, in sync with origin/main at pre-flight)

## Original input

**M03 — `freelo taskchecks` (simple checklist items)**, from `docs/roadmap-migration-2026-08.md` (merged to main in PR #112). New resource: edit, delete, finish, activate for simple checklist items — the `tasks_checks` rows R14 already documents as an auto-fallback when a tasklist can't host smart subtasks, but R14 only covers listing/adding smart subtasks, never managing a simple one once created.

**Endpoints** (verify each against `docs/api/freelo-api.yaml` directly, search for `editTaskcheck`/`deleteTaskcheck`/`finishTaskcheck`/`activateTaskcheck` — don't take this summary on faith): `POST /taskcheck/{id}` (edit), `DELETE /taskcheck/{id}`, `POST /taskcheck/{id}/finish`, `POST /taskcheck/{id}/activate`.

**The central design question for this slice — spend real time here, this is the hard part:** two distinct id spaces exist and the API enforces the split at the HTTP level. A *smart* taskcheck (one with its own `tasks.id`) returns **404** on all four `/taskcheck/{id}...` endpoints — smart ones are edited/deleted/finished/reopened via the *existing* `/task/{id}` paths (R10 edit, R13 delete, R11 finish/reopen — already shipped). A *simple* taskcheck only exists as a `tasks_checks` row and only responds on the `/taskcheck/{id}...` paths. The roadmap's own analysis leans toward: let the user pick the right command based on which kind of id they have, document the distinction clearly in help text, rather than auto-probing (try `/taskcheck/{id}` first, fall back to `/task/{id}` on 404) which could mask a genuine "wrong id" mistake as a silent success. But this is explicitly NOT a settled decision — the roadmap flagged it as something `/spec` should actually weigh, not rubber-stamp. Decide deliberately and log it, considering both the UX cost (a user with a checklist item id has to already know or guess which kind it is) and the correctness cost (auto-probing risks silently doing the wrong thing).

**Other load-bearing behavior notes — verify against the spec text:**

- Edit only accepts `name` and `worker` on a simple taskcheck — `priority_enum`, `priority`, `due_date`, `due_date_end` return 400. This is a materially smaller edit surface than `tasks edit` (R10) — don't reuse R10's full flag set, only expose `--name` and `--worker`.
- All four endpoints accept an optional `notify_author: boolean` (default false) — "keep the caller in notification recipients even though they triggered the action." Same shape across all four; a shared `--notify-author` flag makes sense.
- Delete is a soft-delete (matches every other delete in this API).

**CLI shape:**

```
freelo taskchecks edit <id> [--name <str>] [--worker <id>|--clear-worker] [--notify-author] [--dry-run]
freelo taskchecks delete <id>... [--yes] [--notify-author] [--dry-run]
freelo taskchecks finish <id>... [--notify-author] [--dry-run]
freelo taskchecks reopen <id>... [--notify-author] [--dry-run]
```

**Depends on:** R14 (subtasks, sibling resource — look at its command structure), R13 (confirm/delete pattern, just used again in M02 and M07), R11 (finish/reopen + idempotency pattern) — but explicitly re-derive whether idempotency actually applies here rather than assuming R11's pattern transfers wholesale. Two live precedents this week (M01 comments-delete, M07 files-delete) both found their delete's 404 is ACL-ambiguous ("gone" vs "not yours") and is NOT safe to absorb as idempotent success — check whether `/taskcheck/{id}`'s 404 has the same shape or is genuinely unambiguous, and decide finish/reopen's idempotency policy on the same basis, endpoint by endpoint, not by pattern-matching to the delete precedent alone.

**Repo-wide cautions from recent sibling runs:**

- Do NOT touch, remove, or "clean up" `.claude/settings.json` under any circumstances — intentionally committed shared config (PR #109). If it shows modified/deleted in your working tree, that's a staging mistake, stop and reconcile.
- `test/msw/handlers.ts` resolvers sometimes fire twice per logical request (confirmed repo-wide MSW artifact, not a real double-request) — don't write/trust tests asserting exact request counts; assert content instead.
- Local parallel `pnpm test:cov` runs on this machine have shown load-dependent spurious failures (timeouts + cross-test state bleed) that don't reproduce serially or in CI on recent sibling runs — if you see local failures, verify against `main` and/or a lower-parallelism re-run before concluding regression; let CI be the final word.
- `src/lib/money.ts` does **not** exist, despite earlier roadmap-doc claims to the contrary (found and corrected in M02) — not relevant to this slice's scope, just noted so you don't cite it either.

## Budgets in effect (defaults)

| Resource | Cap |
|---|---|
| Wall clock | 30 min (start 2026-08-29 10:46) |
| Agent invocations | 40 |
| Phase retries (total) | 8 |
| Files touched | 25 |

Overrun of the wall-clock cap is to be logged as a decision rather than used as grounds to shortcut calibration #3's full committed-tree gate run.
