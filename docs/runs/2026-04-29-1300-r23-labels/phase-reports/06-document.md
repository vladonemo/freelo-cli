# Phase 6 — Document (R23 labels)

**Run:** 2026-04-29-1300-r23-labels

## Files

```
docs/commands/labels-list.md        new — synopsis, envelope, examples, errors
docs/commands/labels-rename.md      new — incl. decision 11 callout for --hex
docs/commands/labels-delete.md      new — GLOBAL hard-delete callout, two-arm idempotency table
docs/commands/labels-attach.md      new — fetch-or-create + "no already_in_target_state" caveat
docs/commands/labels-detach.md      new — POST-not-DELETE callout, two-arm idempotency table
README.md                           autogen block regenerated via pnpm fix:readme
.changeset/r23-labels.md            minor changeset
```

Each command page has at least two realistic examples and an errors table
mapping triggers → typed error class → exit code.

## Cross-links

- `labels-delete.md` → `tasks-delete.md` (confirmation policy)
- `labels-attach.md` → `labels-detach.md` (the inverse op)
- `labels-detach.md` → `labels-attach.md` and `labels-delete.md` (the
  destructive sibling)
- All five → `labels-list.md` for label discovery

## README autogen

`pnpm fix:readme` regenerated the autogen block. `pnpm check:readme`
confirms no drift.
