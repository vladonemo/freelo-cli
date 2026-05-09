# R24.5 — Label color palette: `--palette <name>` flag

## Source
`docs/roadmap.md:446-496`

## Summary
Add `--palette <name>` flag (mutex with existing `--hex`) on three commands:
- `freelo labels rename <id>`
- `freelo labels attach`
- `freelo task-labels create`

Nine palette names map to fixed hex values (gray, aqua, blue, green, pink, purple, red, orange, yellow). `--palette` is case-insensitive. Both flags resolve to wire field `color: "#RRGGBB"`. Each command's `--help` lists the palette table inline.

## Constraints
- **No envelope schema change.** Pure client-side enhancement.
- **No API change.** Wire payload unchanged.
- New shared helper: `src/lib/label-color.ts`.
- Existing `parseHexColorFlag` stays for `--hex`.
- Tier expectation: **Yellow** (additive flag, three user-visible commands, minor changeset).
- allowNetwork: false (MSW only).
- autoShip: false.

## Budget
30 min wall clock, 40 agent calls, 8 retries, 25 files.

## Calibration §3 amendment
Pre-commit gate: `pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm fix:readme && pnpm check:readme`. Verify dist/freelo.js mtime newer than latest src/commands/** mtime before README gen.
