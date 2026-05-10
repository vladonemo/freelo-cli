# Phase 2 — Spec

**Run:** 2026-05-10-r44-notes-pins
**Phase:** Spec (re-entered after pause/resume answer A)
**Result:** Success — `docs/specs/0058-r44-notes-pins.md` drafted (7 commands).

## Summary

Spec covers 7 commands across two new top-level parents:

```
freelo notes create / show / edit / delete   (4)
freelo pins  list / add / remove             (3)
```

`notes list` is **dropped** (Option A from the resume); documented in §5
Non-goals with a note that R45+ should add it when Freelo provides a
listing endpoint.

## Decisions surfaced in the spec (full list in §7)

1. `notes list` dropped (Option A).
2. `notes edit` is POST (verb confirmed against OpenAPI yaml :4625; roadmap PATCH is wrong).
3. `notes edit --content` (no `--name`) issues a transparent GET first to fetch the current `name`, then POSTs (wire requires `name`).
4. Empty `--name` / `--content` after trim are rejected at the CLI layer.
5. `notes edit` requires at least one change flag.
6. `notes show` / `edit` / `delete` use `<id>` positional.
7. `notes delete` 200 envelope includes `data.note` (API quirk — yaml :4669); 404 idempotent envelope omits it.
8. `notes delete` single-arm 404 idempotency.
9. `pins remove` single-arm 404 idempotency.
10. `pins add` does NOT surface a `was_existing` flag (server-side fetch-or-create; client diff would drift).
11. `--name` (not `--title`) for create.
12. `--link` (not `--url`) for `pins add` — matches wire field.
13. No client-side URL syntactic validation on `--link`.
14. Notes / Pins are top-level command parents, not nested under `projects`.
15. Both schemas are loose / passthrough; most fields `.optional()` (OpenAPI doesn't mark them required).

## Open questions

None.

## Next phase

3. Plan — already inlined as the `## Plan` section at the bottom of the spec
   file (per `.claude/docs/sdlc.md` Phase 2 convention). Branch creation
   follows.
