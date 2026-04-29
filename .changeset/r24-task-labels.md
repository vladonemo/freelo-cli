---
'freelo-cli': minor
---

R24 — `freelo task-labels create` / `task-labels attach` / `task-labels detach`. Adds the **task-labels** resource group — a sibling of R23's `freelo labels` (project-labels) but a separate Freelo concept: per-account label palette attached/detached to/from individual tasks, identified by UUID and matched by name+color.

```
freelo task-labels create --name <str>...                                       [--hex <color>] [--dry-run]
freelo task-labels attach --task <id> (--name <str>|--uuid <id>)...             [--hex <color>] [--dry-run]
freelo task-labels detach --task <id> (--name <str>|--uuid <id>)...             [--hex <color>] [--dry-run]
```

**Three new envelope schemas (additive):**

- `freelo.task_labels.create/v1` — `data: { labels: TaskLabelEntry[]; count; would? }`.
- `freelo.task_labels.attach/v1` — `data: { task_id; labels: TaskLabelEntry[]; count; would? }`.
- `freelo.task_labels.detach/v1` — `data: { task_id; labels: TaskLabelEntry[]; count; would? }`.

`TaskLabelEntry = { uuid?: string; name?: string; color?: string }`. Each command emits exactly one envelope per invocation (one bulk POST, no per-name fan-out — the API is bulk-by-design).

**Wire bindings (OpenAPI `docs/api/freelo-api.yaml`):**

- `task-labels create` → `POST /task-labels` (yaml :2446) — server-side fetch-or-create on `name` (case-sensitive). API does not report new vs. reused.
- `task-labels attach` → `POST /task-labels/add-to-task/{task_id}` (yaml :2484). Each entry is a `TaskLabelAddInput` `oneOf` — UUID-mode (`{ uuid }`) or name-mode (`{ name, color?, uuid? }`). Mixed within one call supported.
- `task-labels detach` → **`POST /task-labels/remove-from-task/{task_id}`** (yaml :2530). Verb is **POST**, not DELETE — roadmap text was wrong, OpenAPI is authoritative (spec 0036 decision 01; same trap as R23). Each entry is a `TaskLabelRemoveInput` `oneOf` — UUID, name-only (aggressive — removes any color), or name+color (precise).

**Server-side idempotency** — `detach` returns 200 even when the label isn't on the task. No two-arm 404 heuristic needed at the CLI (different shape than R23 `labels detach`).

**Flag-name decision: `--hex` instead of `--color` for all three subcommands (spec 0036 decision 02).** Mirrors R23's spec 0035 decision 11 — the CLI's root program already defines a global `--color <mode>` flag, so the subcommand uses `--hex <color>` to avoid the shadow. The wire field and envelope field are still `color`; the rename is purely lexical at the CLI layer.

**`--hex` semantics differ slightly per subcommand:**

- `create` — applied to every `--name` entry (one color per call; per-name colors require separate invocations — decision 04).
- `attach` — applied to every `--name` entry; `--uuid` entries ignore `--hex` (server uses the existing label's color).
- `detach` — when present, every `--name` entry upgrades from name-only mode → name+color mode (precise removal). `--uuid` entries ignore `--hex`.

**Idempotency caveats:**

- `create` and `attach` are server-side fetch-or-create. The API does not report which were new vs. reused, so the CLI cannot surface that distinction. Re-running with the same args is safe — it's a no-op.
- `detach` — server already-idempotent. Detaching a label that isn't on the task is 200 success.

**Validation (each typed-error path has an exit-code test — Calibration §2):**

- Missing `--name` and `--uuid` (attach/detach) or `--name` (create) → `ValidationError` exit 2.
- `--task` non-positive / non-integer → `ValidationError` exit 2.
- `--hex` not `#RRGGBB` → `ValidationError` exit 2.
- `--uuid` not uuid-shaped → `ValidationError` exit 2.
- Server 4xx/5xx → `FreeloApiError` exit 4 (e.g. 400 "Unsupported color (X) provided.").

**Agent-safe contract reused:**

- `--dry-run` on every leaf — envelope carries `would: { method: 'POST', path, body }`.
- Mixed selectors (`--name` + `--uuid`) supported on attach/detach in one call.
- No `--stdin` in v1 (decision 03 — small surface; can be added later if real workloads need it).
- No destructive prompt on `detach` — label definitions persist after detach (only the assignment is removed).

No new dependencies.
