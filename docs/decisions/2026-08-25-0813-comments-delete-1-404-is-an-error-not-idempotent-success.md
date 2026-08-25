# Decision 1 — 404 on `comments delete` is an error, not idempotent success

**Run:** 2026-08-25-0813-comments-delete
**Phase:** Spec
**Agent:** architect

**Question:** Should `DELETE /comment/{id}` returning 404 be re-classified as success-with-`already_in_target_state: true`, the way `src/commands/tasks/delete.ts` does, or propagate as a `NOT_FOUND` error?

**Decision:** Propagate as `FreeloApiError` / `code: NOT_FOUND` / exit 4. `already_in_target_state` is `false` on every v1 code path. The R13 404-absorbing catch arm is deliberately **not** carried over.

**Alternatives considered:**

- Mirror R13 exactly — absorb 404 into a success envelope with `already_in_target_state: true`. Maximum cross-command consistency; zero new code.
- Absorb only when the caller passes an opt-in flag (e.g. `--ignore-missing`), erroring by default.
- Pre-flight `GET` to disambiguate "gone" from "not yours" before deciding.

**Rationale:** For tasks, 404-on-delete has exactly one meaning (already gone), so reporting success is honest. `docs/api/freelo-api.yaml` :3216 makes it structurally ambiguous for comments — 404 is returned both when the comment doesn't exist *and* when it exists but belongs to another author, deliberately, so that inaccessible comments aren't leaked. Absorbing it would report `exit 0` / "deleted" for a colleague's comment still sitting in the thread: a silent correctness failure, and precisely what the requirement forbids ("Surface this as a plain 'not found' error"). The opt-in-flag variant adds a user-visible flag for a case nobody has asked for; the pre-flight GET was already rejected by R13 decision 4 (two round-trips on a destructive op). Because this breaks a codebase-wide convention it is called out in the changeset, flagged in the PR body, and pinned by regression test #14 so a later "let's make the deletes consistent" refactor fails loudly.
