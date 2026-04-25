# Phase 7 — Document

- `docs/commands/introspect.md`: example output now lists `help` as the last
  entry; the trailing "Notes" item flipped from "the help subcommand is **not**
  included" to "the help subcommand **is** included" with an explanation of
  why the self-reference is correct.
- README autogen Commands block (between `<!-- BEGIN AUTOGEN COMMANDS -->` /
  `<!-- END AUTOGEN COMMANDS -->`): regenerated via `pnpm fix:readme`. New
  `### help` section with one bullet for `freelo help [commandPath...]`.
- `pnpm check:readme` passes on the committed tree.

No human-facing prose elsewhere needed updating (the spec 0004 already
implies the inclusion; the new spec 0008 records the gap-closing decision).
