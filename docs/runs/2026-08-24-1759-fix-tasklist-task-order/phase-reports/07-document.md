# Phase 7 — Document

**Status:** complete
**Files changed:** `docs/commands/tasks-list.md`, `.changeset/empty-hoops-return.md`
**`pnpm fix:readme` required:** no (TODO-10)

## `docs/commands/tasks-list.md`

- The `--order-by` / `--order` rows in the Options table said `unset`, which is now only true on
  `/all-tasks`. Both are marked `unset*` with a footnote pointing at the new section rather than
  inlining a route-conditional default into a table cell.
- New `## Ordering` section, placed between Options and Examples. It covers: ordering is
  server-side and unreconstructable client-side; the per-tasklist default fires only when **both**
  flags are absent; `priority` means manual/drag board order and is *not* the L/M/H task priority
  field; the wire effect, with a worked example of the partial-supply case; that `applied_filters`
  still echoes user flags only; and that `/all-tasks` has no board-order concept at all, so a
  reader chasing board order knows which route they need.
- Deliberately written from the user's side. The live-verification narrative belongs in the spec and
  the OpenAPI `description`, not in a command page.

## `docs/api/freelo-api.yaml`

Covered in `04b-implement-executed.md` and decision 5 — annotate, don't "correct". No account ids,
no captured response bodies, no credentials anywhere in the diff.

## Changeset

`patch`, `.changeset/empty-hoops-return.md`. Says **fixes #108** — spec §6.3's prohibition was
lifted by the live check (§12), so the honest claim is now correctness, not determinism. It also
states explicitly that the envelope is unchanged and the `/all-tasks` route is untouched, since
those are the two things an agent consuming `freelo.tasks.list/v1` would want to know before
upgrading.

## README

No command was added, removed, renamed, or re-described, so the autogen block cannot have changed.
`pnpm check:readme` run anyway — see `06-review.md` §Gates.
