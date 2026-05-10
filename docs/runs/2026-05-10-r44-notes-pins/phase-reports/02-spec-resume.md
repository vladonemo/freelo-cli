# Resume — 2026-05-10 (Europe/Bratislava)

**Paused at:** phase 2 (spec)
**Question:** How should the CLI surface for `notes list` and `notes edit` reconcile with the OpenAPI contract (which defines no listing endpoint and POST-not-PATCH for edit)?
**Answer:** A — drop `notes list` from R44; ship 7 commands.
**Interpretation:** Orchestrator drafts `docs/specs/0058-r44-notes-pins.md` against the seven implementable commands (`notes create / show / edit / delete` + `pins list / add / remove`). The missing-list-endpoint gap is documented in the spec's Non-goals section. `notes edit` uses POST `/note/{id}` internally with the standard CLI flag UX (`--name` / `--content` / `--from-file` / `--editor`). `notes delete` envelope mirrors the API quirk — emits the deleted Note's last state on 200; 404 → standard idempotent envelope `{ id, already_in_target_state: true }` (no body to echo).

Then proceeds through implement / test / review / document / PR per the original requirement. Same coverage / Calibration #3 / `pnpm test:cov` rules apply.

Phase entry point: re-enter phase 2 (spec) — the orchestrator never wrote spec content; re-running spec from a clean slate with the surface gap resolved.

Deferred autonomous decisions retained from `pause.md` §"Other autonomous decisions":
- `notes edit` / `notes show` use `--id <int>` positional arg (mirrors `comments edit`, `tasks show`). No alias.
- `notes create` uses `--name <str>` (matches API field). No alias.
- `pins remove` 404 → `already_in_target_state: true`, exit 0.
