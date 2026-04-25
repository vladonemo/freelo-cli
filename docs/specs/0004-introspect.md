# Spec 0004 — `freelo --introspect` (command-tree discovery)

**Run:** `2026-04-25-1405-introspect`
**Risk tier:** Yellow
**Roadmap slice:** R02.5 (`docs/roadmap.md` lines 80-95)
**Depends on:** R01 (envelope contract, `meta` co-location pattern), R02 (config command surface).

---

## 1. Problem

Today an agent that wants to drive `freelo` programmatically must parse `freelo --help` text, which is unstable, locale-sensitive, and lacks structured information about output schemas, destructive operations, and per-flag types. We need a single, versioned, JSON-only entry point that enumerates the entire CLI surface — every command, subcommand, flag, arg, output schema name, and `destructive` flag — generated at runtime from the Commander program tree (no hand-maintained list, no drift).

This unblocks tool-use manifests for MCP, Claude Code's tool registry, and any CI/automation that consumes the CLI as a structured tool surface. Landing it before the read-only resource commands (R03+) means every later slice automatically shows up in those manifests with zero extra work.

## 2. Proposal — CLI UX

### 2.1 Root flag — primary entry point

```
freelo --introspect
```

- Emits **exactly one line** of JSON to stdout: a single `freelo.introspect/v1` envelope.
- Exits 0 on success.
- Loads no human-UX modules (`@inquirer/prompts`, `ora`, `chalk`, `pino-pretty`, `boxen`, `cli-table3`, `update-notifier`). Verified in a dedicated test (§7.4).
- Honors the global `--output` flag for completeness, but the practical default is JSON regardless of TTY (the flag exists *for agents*; human callers see structured JSON anyway).
- Honors `--request-id`, which appears on the envelope as `request_id` if provided.

### 2.2 Help subcommand alias — agent-friendly form

```
freelo help                         # full envelope when --output is json/auto-on-non-TTY
freelo help --output json           # explicit form, full envelope
freelo help <command>               # scoped envelope (single command match)
freelo help <command> --output json # explicit
freelo help auth login              # scoped to a leaf via space-separated path
```

- A new `help` Commander subcommand with optional positional `[commandPath...]` (variadic).
- Behavior:
  - `--output json` (or `--output auto` resolved to `json` because non-TTY) → emit the introspect envelope (full or filtered to the named command's subtree).
  - `--output human` (or `auto` resolved to `human`) → delegate to Commander's built-in `outputHelp()` for the resolved command. Same text Commander would have written for `freelo --help` / `freelo <cmd> --help`. **No regression** to existing help.
- Unknown command path → `ValidationError` with code `INTROSPECT_UNKNOWN_COMMAND`, exit 2.

The bare `freelo --help` and `freelo <cmd> --help` are **untouched**. This subcommand only adds an alias mode; it does not replace anything.

### 2.3 Examples

```bash
# Full surface as agent input
$ freelo --introspect | jq '.data.commands[].name'
"auth login"
"auth logout"
"auth whoami"
"config get"
"config list"
…

# Scoped to one resource
$ freelo help config set --output json | jq '.data.commands[0].flags'
[]

# Use as MCP tool catalog
$ freelo --introspect > tools.json
```

## 3. API surface

**None.** R02.5 is local-only — the walker reads the in-memory Commander tree built by `buildProgram()` plus each leaf's `register*()` call. There is no Freelo HTTP call, no rate-limit metadata, no `request_id` from a remote server. (The `request_id` slot in the envelope is locally generated, like every other R01/R02 command.)

This matches `docs/specs/0003-config-surface.md` §3 ("no API surface").

## 4. Data model

### 4.1 Envelope schema — `freelo.introspect/v1`

```ts
type IntrospectEnvelope = {
  schema: 'freelo.introspect/v1';
  data: {
    version: string;                  // VERSION from src/lib/version.ts
    commands: IntrospectCommand[];    // sorted by `name` (stable order)
  };
  request_id?: string;                // when --request-id is passed
  // No paging, no rate_limit (no HTTP).
};

type IntrospectCommand = {
  name: string;                       // space-separated path: 'auth login', 'config set'
  description: string;
  args: IntrospectArg[];              // positional, in declaration order
  flags: IntrospectFlag[];            // sorted by long name
  output_schema: SchemaString;        // freelo.<resource>.<op>/v<n>, from meta.outputSchema
  destructive: boolean;               // from meta.destructive
};

type IntrospectArg = {
  name: string;                       // 'key', 'value', 'profile'
  required: boolean;                  // <arg> vs [arg]
  variadic: boolean;                  // <arg...> / [arg...]
  description: string;                // empty string if Commander has none
};

type IntrospectFlag = {
  name: string;                       // long form, e.g. '--output'
  short: string | null;               // '-V' or null
  type: 'boolean' | 'string' | 'string?' | 'string[]' | 'number';
  required: boolean;                  // Commander's option.mandatory
  description: string;
  repeatable: boolean;                // Commander's option.variadic
};
```

The schema string `freelo.introspect/v1` matches the existing `freelo.<resource>.<op>/v<n>` pattern (resource=`introspect`, op implicit, version 1). It is **additive only** to the catalog established in R01/R02; no existing envelope changes.

### 4.2 `meta` contract — already in place

Every leaf command file already exports:

```ts
export const meta = {
  outputSchema: 'freelo.<resource>.<op>/v<n>',
  destructive: false | true,
} as const;
```

verified in: `src/commands/auth/{login,logout,whoami}.ts`, `src/commands/config/{get,list,set,unset,profiles,use,resolve}.ts`. Container files (`auth.ts`, `config.ts`) do NOT export `meta` and do not need to (see Decision 2 in `docs/runs/2026-04-25-1405-introspect/decisions/`).

This spec does not change `meta`'s shape or location. It adds a new exported type alias so the walker has a single source of truth:

```ts
// src/lib/introspect.ts
export type CommandMeta = {
  outputSchema: SchemaString;
  destructive: boolean;
};
```

Each leaf file imports this type and types its `meta` constant against it. Concretely we update the existing `as const` literal export to `: CommandMeta` so the type discipline is enforced at the leaf rather than at the walker. This is non-breaking — TypeScript widens the same literal value through the interface.

## 5. Edge cases

| Case | Behavior |
|---|---|
| New leaf added in a future PR without `meta` export | TypeScript compile error at the import site in `src/lib/introspect.ts` (the registration helper requires `CommandMeta`). Test will also fail. |
| Two leaves declare the same `outputSchema` | Allowed; the walker does not dedupe. (E.g., paginated read commands could share a schema if they returned identical envelopes — none today.) |
| Container command (`auth`, `config`) | Not emitted as its own entry. Its name appears only as a prefix on its leaves. Container's own description is unused in v1. |
| `freelo --introspect` with `--output human` flag passed | The flag is honored; human mode emits a stylized table (lazy-imported). But `--introspect` is for agents — humans use `--help`. Documented but not tested as a primary path. |
| `freelo help <unknown>` | `ValidationError`, code `INTROSPECT_UNKNOWN_COMMAND`, exit 2. Error envelope when non-TTY. |
| `freelo help --output ndjson` | One JSON object per line per command (each command becomes its own line, schema annotation included). Not in roadmap; deferred to R02.6 or later. We reject ndjson with `ValidationError` for v1. |
| Order stability | Commands sorted by `name` ASCII ascending; flags within a command sorted by long name; args in declaration order. Golden test enforces. |
| Empty `flags` / `args` arrays | Always emitted as `[]` (never omitted), matching existing envelope conventions. |
| Walker invoked at any time | Pure (reads Commander state in-memory). No I/O, no async. The bin entry path goes async only because of the existing dynamic `import()` calls for `auth` / `config` registration. |

## 6. Non-goals

- **No runtime side effects from `destructive: true`.** The introspect output is metadata; the runtime confirmation contract is established per-command (R09+). See Decision 3.
- **No drift with `freelo config list`.** `freelo --introspect` enumerates the *command* surface; `freelo config list` enumerates *config keys*. They are orthogonal.
- **No persistent caching.** Generated fresh each invocation. Cheap (<5 ms walk over ~12 commands).
- **No translations / i18n.** Description text is whatever the command file declares.
- **No diffing tools.** Out of scope; agents diff the output themselves.
- **No `freelo introspect` (positional)** — only the `--introspect` flag and the `help --output json` alias. The roadmap is explicit about both forms; a third positional verb would just be alias bloat.

## 7. Open questions

None blocking. The deferred items (logged as autonomous decisions):

1. **`destructive` runtime wiring** — deferred to R09+. (Decision 3.)
2. **NDJSON output mode for introspect** — rejected for v1; revisit if a request lands.
3. **Command aliases (e.g., `auth ls` for `auth list`)** — none today; when added, the walker emits all aliases in a future field bump.

## 8. Plan

### 8.1 Files to add

- `src/lib/introspect.ts` — exports `CommandMeta` type, `attachMeta(cmd, meta)` helper, `walkProgram(program): IntrospectCommand[]`, `buildIntrospectData(program, version): IntrospectData`.
- `src/commands/help.ts` — Commander `help` subcommand registration. Emits introspect envelope on `--output json`, delegates to `command.outputHelp()` on `--output human`.
- `src/ui/human/introspect.ts` — human renderer for the introspect envelope (used only when `--output human` is forced for the introspect path; lazy-loaded chalk/cli-table3 — but in practice rarely exercised). For v1, render a simple grouped tree to stdout. **Optional** — if cost is high, fall back to plain JSON pretty-print and skip chalk import.
- `test/ui/introspect.test.ts` — golden-file test on the envelope shape.
- `test/lib/introspect.test.ts` — unit tests on the walker (flag-type mapping, container skipping, ordering).
- `test/bin/introspect-agent-path.test.ts` — proves `freelo --introspect` path loads no human-UX modules and writes exactly one stdout line.
- `docs/commands/introspect.md` — user-facing doc page.
- `.changeset/<hash>-introspect.md` — minor changeset.

### 8.2 Files to modify

- `src/bin/freelo.ts` — add `.option('--introspect', 'Print the full command tree as a single JSON envelope (agent discovery).')` to `buildProgram()`. Add a top-level handler in `run()` that, if `--introspect` is parsed (Commander runs the option but no subcommand), short-circuits before the preAction hook by detecting the option in the parsed root opts AFTER `parseAsync` would normally handle it. Concretely: register a no-action root handler via `program.action(async () => { … })` that checks for `opts.introspect === true` and emits the envelope, exits 0. If `--introspect` is not set and no subcommand is given, fall back to the existing help-displayed Commander error path.
- `src/commands/auth/login.ts`, `logout.ts`, `whoami.ts` — change the `meta` literal type from inferred `as const` to `: CommandMeta` (still `as const` for narrowing), importing `CommandMeta` from `../../lib/introspect.js`. Wrap the existing `auth.command(...)…` chain so the resulting Commander instance has `meta` attached via `attachMeta(cmd, meta)`. Mechanical, no behavior change.
- `src/commands/config/{get,list,set,unset,profiles,use,resolve}.ts` — same mechanical change.
- `src/bin/freelo.ts` — register the new `help` command (lazy-import path, since it stays on the agent-cold path: dynamic `await import('../commands/help.js')`).

**No new `meta` export needed on `auth.ts` or `config.ts`** — they are containers (Decision 2).

### 8.3 New dependencies

**None.** Commander v12 already exposes `program.commands`, `cmd.options`, `cmd._args`, `cmd.description()`, `option.long`, `option.short`, `option.flags`, `option.required`, `option.optional`, `option.mandatory`, `option.variadic`, `option.description`, `option.parseArg`.

### 8.4 Test strategy

| Layer | File | What it proves |
|---|---|---|
| Unit (walker) | `test/lib/introspect.test.ts` | `walkProgram` returns expected shape on a fixture program. Flag-type mapping covers boolean, string, optional string, variadic, number. Containers are skipped. Ordering is stable. |
| Golden (envelope shape) | `test/ui/introspect.test.ts` | Run `run(['node','freelo','--introspect'])` (or call `buildIntrospectData()` directly), JSON.stringify, compare to `test/fixtures/introspect-golden.json`. **By design, this test fails when a future command is added — agent updates the golden, not the assertion logic.** |
| Integration (`help` alias) | folded into `test/ui/introspect.test.ts` | `freelo help --output json` produces same `data.commands` as `--introspect`. `freelo help auth login --output json` returns one entry whose name is `"auth login"`. `freelo help unknown --output json` exits 2 with `INTROSPECT_UNKNOWN_COMMAND`. |
| Cold-path (lazy-import) | `test/bin/introspect-agent-path.test.ts` | Invoking `--introspect` does not import `@inquirer/prompts`, `ora`, `chalk`, `pino-pretty`, `keytar`. Mirrors `test/bin/agent-path.test.ts` pattern; only `--introspect` argv differs. |
| Coverage | implicit in the above | Hits the new walker (≥90% lines for `src/lib/`), the new `help.ts` command (≥90% lines for `src/commands/`), and the new bin wiring branch. |

### 8.5 MSW handlers

None. R02.5 is local-only.

### 8.6 Rollout slice plan

R02.5 lands as a single PR on `feat/introspect`. Two commits:

1. `feat(introspect): add CommandMeta type and walker (R02.5)` — `src/lib/introspect.ts`, mechanical `meta` typing in every leaf command file, walker tests.
2. `feat(introspect): wire --introspect flag and help --output json alias (R02.5)` — `src/bin/freelo.ts` wiring, `src/commands/help.ts`, `src/ui/human/introspect.ts`, golden test, agent-path test, docs, changeset.

Both commits pass `pnpm lint && pnpm typecheck && pnpm test` independently — the walker is usable from commit 1 even if the flag is wired only in commit 2.

### 8.7 Backwards compatibility audit

- **Existing envelopes** (`freelo.config.<op>/v1`, `freelo.auth.<op>/v1`, `freelo.error/v1`): no change. The walker reads `meta.outputSchema` strings; it does not touch the envelope renderers.
- **Existing flags** (`-V/--version`, `-h/--help`, `--output`, `--color`, `--profile`, `-v/--verbose`, `--request-id`, `-y/--yes`): unchanged. `--introspect` is added.
- **Help text** (`freelo --help`): unchanged. The new `help` subcommand appears in Commander's auto-generated help list as one more subcommand; Commander handles that automatically.
- **Exit codes**: 0 for success, 2 for `INTROSPECT_UNKNOWN_COMMAND` (matches existing `ValidationError` exit code).

### 8.8 Concrete implementation sketch (for the implementer)

```ts
// src/lib/introspect.ts

import { type Command, type Option, type Argument } from 'commander';

export type CommandMeta = {
  outputSchema: SchemaString;
  destructive: boolean;
};

const META = Symbol.for('freelo.introspect.meta');

export function attachMeta<T extends Command>(cmd: T, meta: CommandMeta): T {
  (cmd as unknown as Record<symbol, CommandMeta>)[META] = meta;
  return cmd;
}

export function readMeta(cmd: Command): CommandMeta | undefined {
  return (cmd as unknown as Record<symbol, CommandMeta>)[META];
}

export function walkProgram(program: Command): IntrospectCommand[] {
  const out: IntrospectCommand[] = [];
  walk(program, [], out);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function walk(cmd: Command, path: string[], out: IntrospectCommand[]): void {
  const meta = readMeta(cmd);
  // Container: has children, no meta → recurse only
  if (cmd.commands.length > 0 && !meta) {
    for (const child of cmd.commands) {
      walk(child, [...path, child.name()], out);
    }
    return;
  }
  // Leaf: meta is required
  if (meta) {
    out.push({
      name: path.join(' '),
      description: cmd.description(),
      args: extractArgs(cmd),
      flags: extractFlags(cmd),
      output_schema: meta.outputSchema,
      destructive: meta.destructive,
    });
  }
  // Mixed (rare): emit self if meta present, also recurse children. Today: no such command.
  for (const child of cmd.commands) {
    walk(child, [...path, child.name()], out);
  }
}
```

Each leaf file changes from:

```ts
export const meta = { outputSchema: '…', destructive: false } as const;
…
auth.command('login')…  // unchanged
```

to:

```ts
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';
export const meta: CommandMeta = { outputSchema: 'freelo.auth.login/v1', destructive: false };
…
const cmd = auth.command('login')…
attachMeta(cmd, meta);
```

The `attachMeta` call is added to the existing `register*` functions; the rest of each file is unchanged.

The bin wiring:

```ts
// src/bin/freelo.ts inside run() before parseAsync
program.action(async () => {
  const opts = program.opts<{ introspect?: boolean }>();
  if (opts.introspect) {
    const { buildIntrospectData } = await import('../lib/introspect.js');
    const envelope = buildEnvelope({
      schema: 'freelo.introspect/v1',
      data: buildIntrospectData(program, VERSION),
      requestId: appConfig?.requestId,
    });
    process.stdout.write(JSON.stringify(envelope) + '\n');
    return;
  }
  // No subcommand and no --introspect → show help
  program.outputHelp();
});
```

(The `register help` call lazy-loads `src/commands/help.ts` which mirrors this pattern with positional command-path filtering.)

### 8.9 Risk register

| Risk | Mitigation |
|---|---|
| `meta` typing change breaks an existing leaf | Mechanical edit + `pnpm typecheck` covers it. Each leaf currently uses `as const`; `: CommandMeta` widens slightly but the values remain literal. |
| Walker output stability (golden test churn) | Sort keys, sort commands by name, sort flags by long name. Document the contract in the test file's header. Future command additions are *expected* to update the golden — that's the design. |
| Help subcommand collision with Commander's built-in `helpCommand` | Commander allows registering a command literally named `help`; we override its built-in help command via `program.helpCommand(false)` if needed. Verify in implementation. |
| `--introspect` and `--help` parsed together | `--help` triggers Commander's help-exit before our action runs. `--introspect` wins only when `--help` is absent. Test both. |
| Coverage drop in newly-touched leaf files | `attachMeta` is one additional line per file with no branches. Unit tests on the walker exercise it indirectly. |

### 8.10 Definition of done

- [ ] `pnpm lint` passes.
- [ ] `pnpm typecheck` passes (in particular: `CommandMeta` enforced on all 10 leaves).
- [ ] `pnpm test` passes with coverage targets (lines/statements ≥ 80% global, ≥ 90% in `src/api/**` and `src/commands/**`; branches ≥ 75%).
- [ ] `freelo --introspect` writes exactly one JSON line to stdout, exits 0.
- [ ] `freelo help --output json` returns the same payload.
- [ ] `freelo help auth login --output json` returns a single command entry.
- [ ] `freelo help unknown-cmd --output json` exits 2 with `INTROSPECT_UNKNOWN_COMMAND`.
- [ ] Cold-path test asserts `chalk`, `pino-pretty`, `keytar`, `@inquirer/prompts`, `ora` are NOT loaded on `freelo --introspect`.
- [ ] Golden file `test/fixtures/introspect-golden.json` is committed and matches actual output.
- [ ] `docs/commands/introspect.md` ships, plus a "Tool-use manifests" section in `docs/getting-started.md`.
- [ ] Changeset (`minor` bump) added.
- [ ] PR open, Yellow gate (no auto-merge).
