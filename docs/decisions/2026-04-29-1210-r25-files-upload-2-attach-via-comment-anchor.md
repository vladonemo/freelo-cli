# Decision 2 — `--attach-to-task` posts a comment with `<a data-freelo-uuid>` anchors

**Run:** 2026-04-29-1210-r25-files-upload
**Phase:** spec
**Agent:** architect (orchestrator-driven)

**Question:** How should `--attach-to-task <id>` translate to wire calls? The OpenAPI spec contradicts itself: `POST /file/upload` returns `{ uuid }`, but `comments.files[]` requires `download_url` (which the upload doesn't provide).

**Decision:** Upload all paths first; if at least one upload succeeded, POST `/task/{id}/comments` with `content` embedding `<a data-freelo-uuid="UUID">filename</a>` anchors per the literal documentation at yaml :3876. Do NOT use `comments.files[]`.

**Alternatives considered:**

- Send `files: [{ uuid }]` despite the schema saying `download_url`. Rejected — it's a guess against an authoritative schema.
- Skip the attach feature and require users to call `freelo comments add` separately. Rejected — the roadmap explicitly lists `--attach-to-task` and the documented anchor mechanism makes it implementable.
- Pause and ask. Rejected — the documentation provides a defensible path; this is the kind of decision the autonomous flow is meant to take.

**Rationale:** OpenAPI is authoritative, but inconsistent. Of the two options, only the anchor mechanism is documented for this exact use case. If a future API patch makes `download_url` resolvable, R26 (`files list`) is the natural place to add a `--use-files-array` flag.
