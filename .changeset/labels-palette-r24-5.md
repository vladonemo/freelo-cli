---
'freelo-cli': minor
---

Add `--palette <name>` flag on three label-write commands (R24.5).

**Surface (additive — no breaking change):**

```
freelo labels rename       <id> [--name <str>] [--palette <name> | --hex <#RRGGBB>] ...
freelo labels attach       --project <id> --name <str>... [--palette <name> | --hex <#RRGGBB>] ...
freelo task-labels create  --name <str>... [--palette <name> | --hex <#RRGGBB>] ...
```

Nine palette names map to Freelo's canonical hues, locked at build time:

| Name   | Hex       |
| ------ | --------- |
| gray   | `#77787A` |
| aqua   | `#15ACC0` |
| blue   | `#367FEE` |
| green  | `#10AA40` |
| pink   | `#CA3E99` |
| purple | `#9235E4` |
| red    | `#E9483A` |
| orange | `#F2830B` |
| yellow | `#E3B51E` |

**Behavior:**

- `--palette` and `--hex` are mutually exclusive (`ValidationError`, exit 2; `hintNext` lists the nine names).
- `--palette` is case-insensitive; unknown names fail closed with `ValidationError`.
- `--hex` validation unchanged (`^#[0-9a-fA-F]{6}$`).
- Both flags resolve to the same wire field `color: "#RRGGBB"`. Dry-run envelope's `would.body.color` carries the resolved hex regardless of which flag was used.
- Each command's `--help` lists the palette table inline (Commander long-description block).

**No envelope schema change.** No `freelo.<resource>.<op>/v2` bump. No API call change. Pure client-side discovery layer on top of R23 + R24, surfacing Freelo's fixed nine-color palette by name. New shared helper `src/lib/label-color.ts` is the single source of truth.

No new dependencies.
