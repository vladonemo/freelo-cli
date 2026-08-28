# Decision 2 — Surface the 15-minute window by rewriting the 400 message, not by adding an error code

**Run:** 2026-08-25-0813-comments-delete
**Phase:** Spec
**Agent:** architect

**Question:** The requirement demands a clear, specific error for the expired 15-minute deletion window rather than a generic 400 passthrough. Does that warrant a new `FreeloApiErrorCode` union member (e.g. `COMMENT_DELETE_WINDOW_EXPIRED`), or is a message + `hint_next` rewrite at the command layer enough?

**Decision:** Rewrite `message` and `hintNext` at the command layer, in a `rewriteDeleteCommentError` helper. Keep `code: 'FREELO_API_ERROR'`, `exitCode: 4`, `retryable: false`, and the server's `errors[]` / `httpStatus` / `requestId` untouched. No change to `src/errors/freelo-api-error.ts`.

**Alternatives considered:**

- Add `COMMENT_DELETE_WINDOW_EXPIRED` to the `FreeloApiErrorCode` union so agents can branch on `code` directly.
- Leave the generic message and put the whole explanation in `hint_next` only.
- Map the 400 to `ValidationError` (exit 2) since the request is, in a sense, invalid.

**Rationale:** There is direct precedent one file over — `rewriteEditCommentHint` in `src/commands/comments/edit.ts` :618-633 does exactly this for `comments edit`'s 404. A new union member would touch shared error infrastructure for a single endpoint's single failure mode, and `code` values are part of the agent-facing error contract, so growing that union is a decision better made when a second consumer needs it. Leaving the generic message fails the requirement outright — a human reading `Freelo API error (HTTP 400).` learns nothing. Remapping to `ValidationError`/exit 2 would be actively wrong: exit 2 means "your input was malformed, fix and reprompt", but the id was perfectly valid and no retry or correction will help. The rewritten message names the 15-minute rule, and the hint points at `comments edit`, which the yaml notes has no time limit — the actual workaround.
