# Decision 4 — Flag `type` field inference rules

**Run:** 2026-04-25-1405-introspect
**Phase:** Spec
**Agent:** orchestrator

**Question:** How should the walker map Commander's flag definitions onto the schema's `type` string?

**Decision:** Mirror Commander's `Option` shape:
- Boolean flag (no `<arg>` placeholder, no `<arg...>`): `type: "boolean"`.
- Required value flag (`<arg>`): `type: "string"` (default), or `"number"` if Commander's `argParser` is `Number`.
- Optional value flag (`[arg]`): `type: "string?"`.
- Variadic (`<arg...>` / `[arg...]`): `type: "string[]"`.
- Flag with explicit `argParser` returning a number / int: `type: "number"`.

`required: true` only when Commander reports the option as `mandatory` (set via `option.makeOptionMandatory()`). Today no flags are mandatory. `repeatable: true` when Commander's `Option#variadic` is true OR when the option allows multiple values via repeated flags (Commander treats variadic as the canonical case).

Positional `args` are emitted with `name`, `required` (Commander's `<a>` vs `[a]`), `variadic`, `description` — schema places them under `args: [{ name, required, variadic, description }]` per the roadmap's `{ ..., args, ... }` slot.

**Alternatives considered:**
- Walk Commander's source to read the parsed type. Rejected: fragile across Commander versions.
- Use `zod` to declare per-flag types and join with the Commander option object. Rejected: massive overreach for R02.5; spec 0002 §2.1 already pinned `meta` to a 2-tuple.

**Rationale:** Commander v12 exposes `option.flags`, `option.short`, `option.long`, `option.required`, `option.optional`, `option.variadic`, `option.mandatory`, `option.description`, `option.defaultValue`, `option.parseArg`. These cover every case in the current command surface. The `type` string is a hint for agents, not a runtime contract; we keep it stable and simple.
