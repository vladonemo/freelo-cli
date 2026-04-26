# Phase 2 — Spec

**Run:** 2026-04-26-0914-r04-projects-show
**Status:** complete (resumed after pause)
**Spec:** `docs/specs/0013-projects-show.md`

## Resume context

This phase paused at API research after `freelo-api-specialist` discovered the roadmap's `--with labels` cannot be implemented from the documented Freelo surface. See `pause.md` and `phase-reports/02-api-research.md` for details.

User selected resume option **A: drop `--with labels` from R04**. This phase resumes by writing the spec with that decision baked in, plus a sub-decision under A (paginated `/project/{id}/workers` for `--with workers`).

## Output

- `docs/specs/0013-projects-show.md` (~290 lines).
- Decision log entries 1–4 captured in `docs/decisions/`:
  1. R04 ships without `--with labels`.
  2. `--with workers` uses paginated `/project/{id}/workers`.
  3. Envelope shape: `data.project` always present, `data.workers` only when requested.
  4. 404 / 403 hint rewriting lives in the command layer, not the HTTP client.

## Tier confirmation

Tier remains **Yellow**. The change is:
- additive (new command, new envelope schema),
- non-breaking (no flag removals or rename, no exit-code changes, no auth/HTTP-defaults touch),
- zero new runtime dependencies.

No security review trigger. No spec open questions remain unresolved.

```
ARCHITECT phase=spec run=2026-04-26-0914-r04-projects-show status=ok tier=Yellow open_questions=0
```
