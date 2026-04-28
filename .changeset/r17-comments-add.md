---
'freelo-cli': minor
---

R17 — `freelo comments add`. Post a single comment to a task without leaving the terminal. Second leaf under the `comments` subcommand (R16 added `list`).

```
freelo comments add --task <id>
                    (--message <str> | --from-file <path> | --editor | -)
                    [--dry-run]
```

**Four input sources, exactly-one-required:**

- `--message <str>` — inline pass-through (one-liners).
- `--from-file <path>` — read a UTF-8 file.
- `--editor` — open `$VISUAL` / `$EDITOR` (TTY-only).
- `-` (positional) — read stdin to EOF.

The file / editor / stdin paths reuse `src/lib/input.ts` (R15); `--message` is layered on inline. Mutex enforced — zero or two-of-four sources fail with `VALIDATION_ERROR` (exit 2). Empty content is rejected at the command layer before any wire round-trip.

**One new envelope schema (additive surface):**

- `freelo.comments.add/v1` — `{ task_id, comment, source, byte_length, is_description, would? }`. `comment` / `source` / `is_description` are present in live envelopes, absent in `--dry-run`; `would` is the inverse. `byte_length` is always present.

**Server-side auto-flip surfaced to agents.** When the target task has no prior comments, the Freelo API converts this POST into the task's **description** instead of a regular comment (per `docs/api/freelo-api.yaml:2589-2592`). The CLI does not branch on this — it surfaces the flip via `data.is_description: true` (always present, defaults to `false`) so agents can detect-after-the-fact, and the human-mode message points at `freelo tasks description set` for explicit description writes.

**Idempotency: N/A by design.** Each POST creates a new comment row; there is no natural-key dedupe. Two consecutive identical invocations create two identical comments. `--dry-run` is the safety net.

**Out of scope for v1:**

- No `--files` / multipart attachments — multipart upload helper lands at R25.
- No batch input (`--ids` / `--stdin` NDJSON of `{task_id, content}`) — single-comment-per-invocation only.
- No edit / delete — those land at R18.

No new dependencies. Reuses `commander`, `zod`, `undici` (via the shared HTTP client), `src/lib/input.ts`, `src/lib/dry-run.ts`, and `src/ui/envelope.ts`.
