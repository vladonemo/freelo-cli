# Requirement — R40 (Wave 7, slice 1)

**Run:** 2026-05-10-r40-custom-fields-types-list
**Mode:** autonomous (`/auto`)
**Date:** 2026-05-10

## Original requirement

R40 — `freelo custom-fields types` / `list` (Wave 7, first slice — Custom fields, notes, pinned items)

Source: `docs/roadmap.md` Wave 7 section.

> **Endpoints:** `GET /custom-field/get-types`, `GET /custom-field/find-by-project/{project_id}`.
> **CLI:** `freelo custom-fields types` / `freelo custom-fields list --project <id>`.
> **Depends on:** R04.

This is a **read-only** slice — two new subcommands under a new top-level `custom-fields`
parent. No writes, no destructive ops, no auth changes.

## Run parameters

- run-id: `2026-05-10-r40-custom-fields-types-list`
- allowNetwork: false (MSW only)
- autoShip: false (do NOT publish to npm)
- budget: defaults (30 min wall clock, 40 agent calls, 8 retries, 25 files)

## Pre-flight

- On `main`, fast-forwarded to `519d699` (post-Wave-6 cleanup).
- Working tree clean, lockfile current.

## Branch (target)

`feat/r40-custom-fields-types-list`
