# Spec 0008 — Include `help` subcommand in `freelo --introspect`

**Run:** `2026-04-25-2110-help-introspect-meta`
**Risk tier:** Yellow
**Depends on:** Spec 0004 (introspect contract).

---

## 1. Problem

The `help` subcommand exists in the live Commander tree and is publicly
documented (`docs/commands/introspect.md`, README), but it is **not** emitted
in `data.commands` of the `freelo.introspect/v1` envelope. The R02.5 spec
(0004) implies it should be enumerated like every other public command — its
§2 example references `help` as part of the surface — yet the implementation
in `src/commands/help.ts` deliberately omits the `meta` attachment, so the
walker (which only emits leaves carrying `meta`) skips it.

Agents that consume `--introspect` as a tool catalog therefore get an
incomplete view: they cannot programmatically discover `help`, even though
it is the documented agent-friendly entry to scoped help text.

## 2. Proposal

Attach `CommandMeta` to the `help` subcommand so the walker emits one more
leaf entry. No surface-shape change.

Concrete entry that lands in `data.commands`:

```json
{
  "args": [
    {
      "description": "",
      "name": "commandPath",
      "required": false,
      "variadic": true
    }
  ],
  "description": "Print the command tree as JSON (--output json) or as the same text as --help (default).",
  "destructive": false,
  "flags": [],
  "name": "help",
  "output_schema": "freelo.introspect/v1"
}
```

The entry is self-referential: `help`'s structured output schema **is** the
introspect envelope. That is correct, not a hack — `freelo help --output json`
emits exactly that envelope.

## 3. API surface

None. Local-only.

## 4. Data model

No envelope-shape change. Schema `freelo.introspect/v1` unchanged.
`data.commands` gains one entry; the array shape is unchanged.

## 5. Edge cases

| Case | Behavior |
|---|---|
| `help` listed in golden-fixture order | Sorted ASCII-ascending alongside other leaves. Currently lands as the new last entry (after `config use`). |
| `freelo help help --output json` | Resolves to the `help` leaf via `filterByPath('help')`; returns a single-entry array with the new `help` entry. |
| `freelo help help --output human` | Delegates to Commander's `outputHelp()` for the help command — prints help text for `help` itself. Standard Commander behavior. |
| README autogen | `pnpm fix:readme` regenerates the autogen Commands block to include the new row. |

## 6. Non-goals

- Not making `help` recursive in any deeper sense (no nested entries beyond the
  single leaf).
- Not changing `freelo.introspect/v1`'s schema shape — adding an entry to a
  list is content, not a schema change.
- Not changing the existing exclusion-of-`--help`/`--version` flags rule in
  the walker.

## 7. Open questions

None.

## 8. Plan

### 8.1 Files to modify

- `src/commands/help.ts` — import `attachMeta` and `CommandMeta`; export
  `meta = { outputSchema: 'freelo.introspect/v1', destructive: false }`;
  attach it to the registered Commander command via `attachMeta(helpCmd, meta)`.
  Replace the trailing comment with the new rationale.
- `test/fixtures/introspect-golden.json` — refreshed via `vitest -u` to add
  the new `help` entry in sort order.
- `test/ui/introspect.test.ts` — flip the negative assertion ("does not emit
  the help command") to a positive one ("emits the help command with the
  introspect output schema").
- `README.md` — autogen Commands block regenerated via `pnpm fix:readme`.
- `.changeset/<hash>-help-in-introspect.md` — minor changeset (additive
  envelope content + README delta).

### 8.2 New dependencies

None.

### 8.3 Test strategy

- Existing golden-snapshot test auto-updates with `vitest -u`.
- The negative-assertion test in `test/ui/introspect.test.ts` is inverted to
  assert the entry is present and well-formed (name `'help'`, output_schema
  `'freelo.introspect/v1'`, single variadic arg).
- All other introspect tests remain unchanged.

### 8.4 Rollout

Single commit: `feat(introspect): include help subcommand in --introspect data`.

### 8.5 Definition of done

- [ ] `pnpm lint && pnpm typecheck` pass.
- [ ] `pnpm test` passes (golden refreshed; inverted assertion passes).
- [ ] `pnpm build && pnpm fix:readme` is run; resulting README delta committed.
- [ ] `pnpm check:readme` passes on the committed tree.
- [ ] Changeset entry added (minor).
- [ ] PR opened; Yellow → human merge.
