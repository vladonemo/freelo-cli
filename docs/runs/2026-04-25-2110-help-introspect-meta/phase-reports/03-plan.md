# Phase 3 — Plan

Plan inlined as §8 of `docs/specs/0008-help-in-introspect-data.md`.
Files to modify (all small, mechanical):
- `src/commands/help.ts` — add `meta`, attach via `attachMeta()`.
- `test/ui/introspect.test.ts` — invert the negative assertion.
- `test/fixtures/introspect-golden.json` — refresh via `vitest -u`.
- `README.md` — autogen Commands block via `pnpm fix:readme`.
- `.changeset/help-in-introspect-data.md` — minor.
- `docs/commands/introspect.md` — update example output and the trailing note.

No new dependencies.
