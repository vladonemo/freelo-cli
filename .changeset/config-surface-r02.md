---
'freelo-cli': minor
---

feat(config): add full `freelo config` command tree (R02)

New subcommands: `config list`, `config get`, `config set`, `config unset`,
`config profiles`, `config use`, `config resolve`.

**Store schema bump v1 → v2** (additive migration, read-on-load, no write-back):
- Adds a `defaults` map for output/color/verbose overrides.
- Old v1 stores are silently migrated in memory; the file is only rewritten on
  the next mutating command.

**RC file support** (`.freelorc`, `.freelorc.json`, `.freelorc.yaml`):
- Slotted between environment variables and the conf store.
- Unknown keys and inline API tokens are rejected with exit 2 (`corrupt-rc`).

**`ProfileSource` extended** with the new `'rc'` literal.

**New envelope schemas (public contract)**:
- `freelo.config.list/v1`
- `freelo.config.get/v1`
- `freelo.config.set/v1`
- `freelo.config.unset/v1`
- `freelo.config.profiles/v1`
- `freelo.config.use/v1`
- `freelo.config.resolve/v1`

**New runtime dependency**: `cosmiconfig@^9.0.0` for project-level rc file discovery (JSON + YAML).

**`ProfileSource` extended** with the new `'generated'` literal for runtime-minted values (e.g. auto-generated request IDs).
