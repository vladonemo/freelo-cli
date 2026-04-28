---
'freelo-cli': minor
---

R18 — `freelo comments edit`. Overwrite the content of one or more existing comments without leaving the terminal. Third leaf under the `comments` subcommand (after R16 `list`, R17 `add`).

```
freelo comments edit <id>...                           # variadic positional
freelo comments edit --ids "1,2,3"                     # batch flag
freelo comments edit --stdin                           # NDJSON {id, content} per row
                     (--message <str> | --from-file <path> | --editor | -)
                     [--dry-run]
```

Wraps `POST /comment/{comment_id}` (OpenAPI `editComment`, yaml :2619-2663). The verb is **POST**, not PUT/PATCH — yaml :2634 documents this explicitly: "POST for historical reasons, not PUT/PATCH."

**Three input sources (mutex), four content sources (mutex on non-stdin paths):**

- Input: positional `<id>...` / `--ids` / `--stdin` (NDJSON `{id, content}` per row).
- Content (non-stdin paths): `--message <str>` / `--from-file <path>` / `--editor` / `-` (stdin sentinel, single-id only).
- `--stdin` owns per-row content — combining it with a content source is rejected.

Reuses `src/lib/input.ts` (R15), `src/lib/batch.ts` (R09), `src/lib/dry-run.ts` (R09).

**One new envelope schema (additive surface):**

- `freelo.comments.edit/v1` — `{ comment_id, comment?, source?, byte_length, line_index?, would? }`. `comment` and `source` are present in live envelopes and absent on `--dry-run`; `would` is the inverse; `line_index` rides on `--stdin` rows; `byte_length` is always present.

**Edit is non-destructive and not absorbing-state.** No `--yes` interaction (no confirmation prompt). No `already_in_target_state` field (every successful POST returns the updated comment). Two consecutive identical edits both report success.

**Per yaml :2631-2633, ACL violations on edit return 404, not 403** — to avoid leaking comment existence. The CLI's 404 hint surfaces both possible causes ("not found, or your account does not have permission").

**Roadmap correction:**

- §R18 corrected to drop the `PATCH` mention and the `comments delete` clause. Slice title renamed to `R18 — \`freelo comments edit\``.
- New `R18.5 — \`freelo comments delete\` (queued)` entry added — endpoint **not in `docs/api/freelo-api.yaml`** as of 2026-04-28; first action is `freelo-api-specialist` confirmation against a live test account.

**Out of scope for v1:**

- No `--files` / multipart attachment replacement — multipart helper lands at R25. Wire body sends only `content`; existing attachments are left untouched per yaml :2632.
- No `comments delete` — deferred to R18.5.

No new dependencies.
