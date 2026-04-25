# Spec 0005 — `freelo help <parent>` parent-group filter fix

**Run:** `2026-04-25-1935-introspect-help-filter-fix`
**Risk tier:** Green
**Type:** bugfix (patch)
**Depends on:** R02.5 (`docs/specs/0004-introspect.md`)

---

## 1. Problem

In `freelo-cli@0.3.0`, calling `freelo help <parent-group> --output json` for any
non-leaf command path fails with `VALIDATION_ERROR: Unknown command '<parent>'`,
exit 2:

```
$ npx freelo-cli@0.3.0 help config --output json
freelo error: Unknown command 'config'.
$ echo $?
2
```

`freelo help auth --output json` has the same failure. Only fully-qualified
leaves work (`help auth login --output json` is fine).

The agent-friendly use case "give me everything under `config`" is broken,
forcing callers to enumerate leaves manually — which defeats the point of the
introspect surface.

### Root cause
`filterByPath` in `src/lib/introspect.ts` does an exact-match lookup
(`commands.find(c => c.name === wanted)`). The introspect data structure only
stores **leaves** (e.g. `auth login`, `config get`) — never the parent groups
(`auth`, `config`). So `help config --output json` finds zero matches and the
caller throws `VALIDATION_ERROR`.

## 2. Proposal

Change `filterByPath` from a single exact-match to a **prefix match against the
command path**:

- A leaf `c.name === wanted` matches (preserves the leaf case).
- A leaf `c.name.startsWith(wanted + ' ')` matches (covers parent-group case).
- Empty result is still an "unknown command" error.

The function returns the **filtered array** of `IntrospectCommand[]` instead of
a single `IntrospectCommand | undefined`. The caller (`src/commands/help.ts`)
emits the scoped envelope using that array directly, retaining the existing
"unknown path" error for empty results.

### Examples

```bash
# Parent-group: previously errored, now returns 7 entries.
$ freelo help config --output json | jq -r '.data.commands[].name'
config get
config list
config profiles
config resolve
config set
config unset
config use

# Leaf: still works, returns exactly 1 entry.
$ freelo help auth login --output json | jq -r '.data.commands[].name'
auth login

# Truly unknown path: still errors with VALIDATION_ERROR exit 2.
$ freelo help nonexistent --output json
{"schema":"freelo.error/v1",...}
$ echo $?
2
```

## 3. API surface

**None.** Local-only behavior fix.

## 4. Data model

**No envelope schema change.** `freelo.introspect/v1` stays at v1.

The shape of `data.commands` is unchanged — still a flat array of leaves. Only
the *content* served for parent-group queries changes (previously: error;
now: the parent's subtree of leaves). Agents that already walk
`data.commands` keep working with no migration.

The internal `filterByPath` signature changes from
`(commands, path) => IntrospectCommand | undefined` to
`(commands, path) => IntrospectCommand[]`. This is a **non-public** helper —
not exported in the package surface — so the signature change has no backwards
compatibility implication.

## 5. Edge cases

| Case | Behavior |
|---|---|
| `help config --output json` | Returns 7 leaves under `config`. |
| `help auth --output json` | Returns 3 leaves under `auth`. |
| `help auth login --output json` (leaf) | Returns 1 entry. Unchanged. |
| `help --output json` (no path) | Returns the full envelope. Unchanged. |
| `help nonexistent --output json` | `VALIDATION_ERROR` exit 2. Unchanged. |
| `help auth lo --output json` (partial leaf token) | `VALIDATION_ERROR` — must be full name segments. The prefix match uses `startsWith(wanted + ' ')`, so "auth lo" does not match "auth login". |
| `help config get --output json` (full leaf) | Exact match returns just that leaf, even though it is also a prefix of nothing else. |
| Order stability | Subset of the already-sorted `commands` array; relative order preserved. |
| Path with extra spaces | `path.trim()` and the existing space-joined caller handle it; `wanted` stays exact. |

## 6. Non-goals

- **No parent-group entries added to `data.commands`.** Preserves the current
  shape; agents that walk the array don't break. Containers stay implicit
  (their existence is inferred from the prefix in leaf names).
- **No envelope schema bump.** This is a behavior fix on what *content* is
  returned, not a contract change. Schema stays `freelo.introspect/v1`.
- **No `help` leaf added to introspect output.** The exclusion at
  `src/commands/help.ts` (no `attachMeta` call) is by design — leave it alone.
- **No partial-token matching.** `help auth lo` is still an error (must use
  full segments).
- **No human-mode change.** `--output human` already works for parent groups
  via `resolveCommandForHelp` + `Command.outputHelp()`. Unchanged.

## 7. Open questions

None.

## 8. Plan

### 8.1 Files to modify

- `src/lib/introspect.ts` — change `filterByPath` to return an array, prefix-match.
- `src/commands/help.ts` — update `filterToPath` caller to consume the array
  and treat empty as the unknown-path error.

### 8.2 Files to add

- `.changeset/<hash>-introspect-help-filter-fix.md` — `freelo-cli: patch`.

### 8.3 Files to update

- `test/ui/introspect.test.ts` — add three cases:
  - `help config --output json` → 7 entries, all `name` starts with `config`.
  - `help auth --output json` → 3 entries, all `name` starts with `auth`.
  - keep the existing `help auth login --output json` → exactly 1 entry.
- `test/lib/introspect.test.ts` — unit cover the new `filterByPath` behavior
  (leaf, parent, unknown, partial token).
- `docs/commands/introspect.md` — add a "Scoped help" section showing the
  parent-group case.

### 8.4 No new dependencies

None.

### 8.5 Test strategy

- Unit: pure tests on `filterByPath` covering leaf / parent / unknown / partial-token.
- Integration: `runCmd(['help','config','--output','json'])` parses the envelope
  and asserts the 7 names. Same for `auth`.
- Regression: existing leaf and unknown-path tests still pass.

### 8.6 Rollout

Single commit on `fix/introspect-help-parent-filter`:
`fix(lib): scope freelo help <parent> --output json to the parent's subtree`.

Optionally a second commit for docs + changeset, but a single commit is cleaner
for a patch this small and is explicitly allowed by the run plan.

### 8.7 Definition of done

- [ ] `pnpm lint` passes.
- [ ] `pnpm typecheck` passes (against the staged-and-committed tree).
- [ ] `pnpm test` passes — new cases included; coverage targets met.
- [ ] `help config --output json` returns 7 entries.
- [ ] `help auth --output json` returns 3 entries.
- [ ] `help auth login --output json` still returns 1 entry.
- [ ] `help nonexistent --output json` still exits 2 with `VALIDATION_ERROR`.
- [ ] Changeset (`patch`) added.
- [ ] Docs updated with the scoped-help section.
- [ ] PR open, Green gate (auto-merge enabled).
