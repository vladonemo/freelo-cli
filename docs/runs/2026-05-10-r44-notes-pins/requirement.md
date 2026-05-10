# R44 — `freelo notes` + `freelo pins` (final Wave 7 slice)

From `docs/roadmap.md`:

> **Outcome:** Two related small surfaces, bundled because each is tiny.
> **Endpoints:** `GET/POST /project/{id}/note`, `GET/PATCH/DELETE /note/{id}`; `GET /project/{id}/pinned-items`, `POST /project/{id}/pinned-items`, `DELETE /pinned-item/{id}`.
> **CLI:**
> ```
> freelo notes list --project <id>        # …create / show / edit / delete
> freelo pins list --project <id>         # …add <url> / remove <id>
> ```
> **Depends on:** R04, R13.

Run-id: `2026-05-10-r44-notes-pins`
Branch (planned): `feat/r44-notes-pins`
Spec number (planned): `0058`
Budget: defaults (30 min, 40 calls, 8 retries, 25 files)
allowNetwork: false
autoShip: false
