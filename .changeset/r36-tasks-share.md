---
'freelo-cli': minor
---

feat(commands): tasks share / unshare — public share link for a task (R36)

Two new subcommands:

- `freelo tasks share <id>` — get (or create) a public, unauthenticated URL
  that lets anyone holding the link view the task read-only. Idempotent on
  the wire — first call mints the URL, subsequent calls return the same
  one. Output schema: `freelo.tasks.share/v1`.

- `freelo tasks unshare <id>` — revoke the public link. Destructive; reuses
  the shared confirmation gate (`--yes` / TTY prompt; non-TTY without
  `--yes` fails closed with `CONFIRMATION_REQUIRED` exit 2). Idempotent:
  a defensive 404 (no-link-existed) is re-classified as
  `already_in_target_state: true`. Output schema:
  `freelo.tasks.unshare/v1`.

Both leaves support `--dry-run`. Single-id v1 (no batch).

New envelope schemas: `freelo.tasks.share/v1`, `freelo.tasks.unshare/v1`.

Wire endpoints: `GET /public-link/task/{id}`, `DELETE /public-link/task/{id}`
(per the OpenAPI spec — note the GET verb on share, which Freelo treats as
a "GET that creates").
