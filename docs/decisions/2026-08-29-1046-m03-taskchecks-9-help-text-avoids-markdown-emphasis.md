# Decision 9 — Command help text must not contain `*emphasis*`; it breaks `pnpm check:readme`

**Run:** 2026-08-29-1046-m03-taskchecks
**Phase:** document / gate
**Agent:** orchestrator (doc-writer mandate)

**Question:** `pnpm check:readme` failed on the committed tree even though `pnpm fix:readme` had been run and had reported success moments earlier. Why, and what is the fix?

**Decision:** Remove markdown emphasis from all four command `.description()` strings — `*simple*` became `simple (non-smart)`. The README autogen block now survives a prettier pass byte-identical.

**The mechanism** (worth recording, because the failure looks impossible):

1. The four descriptions contained `*simple*` for emphasis.
2. `pnpm fix:readme` writes `freelo --introspect` output verbatim into the README block — including `*simple*`.
3. `lint-staged`'s prettier pass on commit rewrites markdown emphasis to its preferred delimiter: `*simple*` → `_simple_`.
4. `pnpm check:readme` re-renders from `--introspect` (still `*simple*`) and compares against the committed README (now `_simple_`) → mismatch.

So the pre-commit hook and the CI check disagreed by construction, and every `fix:readme` → commit cycle re-broke it. Running `fix:readme` again could never converge.

**Alternatives considered:**

- **Add the README autogen block to `.prettierignore`.** Rejected: it is a shared-config change with blast radius beyond this slice, and the block genuinely should be prettier-clean like the rest of the file.
- **Teach `scripts/check-readme.mjs` to normalise emphasis before comparing.** Rejected for this slice: it makes the check fuzzier to fix a problem better solved by not putting markdown syntax in CLI help text, which is rendered in a terminal where `*simple*` shows up as literal asterisks anyway.

**Rationale:** Help text is terminal output first and markdown second. Emphasis markers read as noise in `--help` and are actively harmful once they round-trip through the README generator. The emphasis is preserved where it belongs — in `docs/commands/taskchecks-*.md` and in the error `hint_next` strings, neither of which feeds the autogen block.

**Generalisable rule for future slices:** never put `*`, `_` or other markdown emphasis in a Commander `.description()`. Backticks are safe (prettier leaves inline code alone) and are already used throughout. This is a good candidate for a lint rule or a `check-readme` warning.

Caught by calibration §3 — running the gates on the clean committed tree rather than the working tree is exactly what surfaced it.
