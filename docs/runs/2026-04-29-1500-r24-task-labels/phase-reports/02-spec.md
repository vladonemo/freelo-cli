# Phase 02 — Spec

**Spec:** docs/specs/0036-r24-task-labels.md
**Lines:** ~280
**OpenAPI verified:** yes — all three endpoints are present in `docs/api/freelo-api.yaml` :2446-2573 with full request/response schemas.

## Decisions made

1. Detach verb is **POST** per OpenAPI (roadmap incorrectly says DELETE — same divergence as R23 project-labels).
2. Color flag named `--hex` (not `--color`) to avoid the existing root `--color <mode>` flag.
3. No `--stdin` in v1.
4. Single `--hex` applies to all `--name` entries in one call.
5. One bulk POST per command (no fan-out — API is bulk-by-design).

## Open questions: none

All API behavior in OpenAPI yaml; all flag semantics from roadmap signature + project precedent.
