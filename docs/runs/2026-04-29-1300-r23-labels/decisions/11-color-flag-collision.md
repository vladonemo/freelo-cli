# Decision 11 — Resolve `--color` flag collision with global flag

**Run:** 2026-04-29-1300-r23-labels
**Phase:** Implement (Phase 3 takeover)
**Agent:** orchestrator

## Question

The spec (and roadmap) call for `freelo labels rename --color <hex>` and
`freelo labels attach --color <hex>`. The CLI's root program already
defines a global `--color <mode>` flag (auto/never/always — output
colorization).

When the same flag name is registered on both the root and a subcommand,
Commander walks up the chain: the root option wins regardless of registration
order, so the subcommand's `--color <hex>` is shadowed and the user's hex
value is captured by the root flag (rejected as an invalid color mode at
the env-resolution layer).

Verified by a minimal repro and by an end-to-end test failure
(`labels rename 12 --color "#9b59b6"` → `applied_changes` is empty;
empty-edit guard or wire body lacks `color`).

## Decision

**Rename the subcommand flag from `--color <hex>` to `--hex <color>`** on
both `labels rename` and `labels attach`. Add a clarifying description so
agents reading `--help` or `--introspect` see the rationale.

Spec is updated (this decision is the source of truth for any drift) but
the spec file itself is not edited; the changeset and the rename's
inline doc-comment will note "decision 11" so future readers can reconcile.

## Alternatives considered

- **`enablePositionalOptions()` on the root program.** Would route all
  options after the subcommand to the subcommand. Risky: every other
  command's tests pass `--output json` / `--profile X` AFTER the subcommand
  name (current behavior). Switching the parsing model breaks those flows
  silently.
- **Rename the global root `--color <mode>` flag.** Breaking change to
  every prior release; affects the public CLI surface and every doc page.
  Not justified by an additive-only slice.
- **Disambiguate by value (root re-routes hex values to subcommand).**
  Hacky, invisible to `--help`, and impossible for an agent to discover
  via `--introspect`. Rejected.
- **Accept the spec name and accept the test failure.** Not viable —
  the wire body would never carry `color`.

## Rationale

`--hex <color>` is an unambiguous flag name across the CLI surface. It
documents itself (a hex color in `#RRGGBB` form) and removes the
collision permanently without disturbing any other command. The
information loss vs. spec wording is purely lexical — the underlying
wire-body field is still `color` and the envelope still echoes
`applied_changes.color` / `data.color` so envelope semantics are
unchanged. Agents using `--introspect` see the new flag name and the
help text explains it.

This is the same pattern used in prior slices when the roadmap and the
implementable surface drift (R18 PATCH→POST, R20 deferred `--started-at`,
R23 deferred `--project` filter on list — see decisions 01-03).
