---
'freelo-cli': minor
---

Add `freelo task-labels colors` (M05) — the task-label color palette the Freelo server actually accepts, plus a drift check against the CLI's built-in `--palette` names.

```bash
freelo task-labels colors
```

**New envelope schema: `freelo.task_labels.colors/v1`.** `data` carries `colors[]` (each entry adds `palette_name` to the wire's `color` / `display_name` / `is_default`), `count`, `default_color`, and a `drift` object with `matches`, `server_only` and `local_only`. No existing schema is changed.

Notable behavior:

- **`--palette` is unchanged.** The nine-name table in `src/lib/label-color.ts` remains the sole, offline validator for `--palette` on every command that takes a color. This command is a check on that table, not a runtime dependency of it — validation stays local, free, and works without a network or credentials. The API's `display_name` is documented as display-only and is not accepted as input, so there is no server-side name vocabulary to adopt.
- **Drift is data, not an error.** Exit is 0 whether or not the tables agree. A scheduled check reads the field: `freelo task-labels colors --output json | jq -e '.data.drift.matches'`.
- **`palette_name` is not `display_name`.** `palette_name` is what you type into `--palette` (or `null` when the CLI has no name for a server color — reach it with `--hex`). `display_name` is Freelo's own label and is not typeable anywhere.
- Hex comparison is **case-insensitive**: the wire sends lowercase, the local table stores uppercase, and that difference alone is never reported as drift.
