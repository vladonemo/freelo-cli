# Decision 2 — `meta` is mandatory **per leaf command**, not per file

**Run:** 2026-04-25-1405-introspect
**Phase:** Spec
**Agent:** orchestrator

**Question:** Should `meta: { outputSchema, destructive }` be type-mandatory on every command file, or only on leaf command modules?

**Decision:** **Mandatory per leaf module.** Define a `CommandMeta` type and a `LeafCommandModule` interface in `src/lib/introspect.ts`. Each leaf command module (the existing `src/commands/auth/{login,logout,whoami}.ts`, `src/commands/config/{get,list,set,unset,profiles,use,resolve}.ts`) must export `meta: CommandMeta` typed as `{ outputSchema: \`freelo.${string}/v${number}\`; destructive: boolean }`. The walker reads `meta` via a co-located registration call (same `register*` functions today) that attaches the `meta` to the Commander `Command` instance via `Command.copyInheritedSettings`-adjacent state — concretely, we wrap `command.action(handler)` with a thin helper `attachMeta(cmd, meta)` that stores `meta` on the Commander instance (Commander allows arbitrary properties).

Container/parent files (`src/commands/auth.ts`, `src/commands/config.ts`) export **no** `meta` because they are not leaf commands — they group children. The walker skips containers (any `Command` with `.commands.length > 0` and no `.action` registered) when emitting the `commands[]` array; they only contribute their name as a prefix to leaf names (`auth login`, `config set`).

**Alternatives considered:**
- Make every file export `meta`, including parents. Rejected: forces a synthetic `outputSchema: null` and confuses what "destructive" means on a container.
- Make `meta` optional and runtime-fallback to nullable fields. Rejected: violates the roadmap's "type-checked" requirement and weakens agent-first guarantees (a future leaf command without `meta` should be a TS error, not a `null` in JSON).
- Use a separate central registry file. Rejected: violates spec §2.1 in 0002 ("`meta` co-located with command file") and increases drift risk.

**Rationale:** Leaves are the only entries in the introspect output, so the type guarantee belongs there. Parent containers are an artifact of Commander's hierarchical command model and have no `outputSchema`. This matches spec 0002 §2.1 and 0003 §2.1 which already declare `meta` only on leaf files. No retro-fit to existing files needed; the walker just needs a way to fetch leaf meta when it visits each leaf.
