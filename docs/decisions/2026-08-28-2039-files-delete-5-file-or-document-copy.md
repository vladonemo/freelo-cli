# Decision 5 — Human copy and prompt say "file or document", not "file"

**Run:** 2026-08-28-2039-files-delete
**Phase:** spec
**Agent:** orchestrator (executing the `architect` mandate)

**Question:** The command lives under `freelo files` but the endpoint also deletes documents/notes, and
its response carries no discriminator saying which kind it removed. What should the success line, the
confirmation prompt, and the 404 message call the thing?

**Decision:** "file or document" everywhere the CLI speaks about the resource in prose:
`Deleted file or document <uuid>.`, `(dry-run) Would delete file or document <uuid>.`,
`Delete 3 files or documents?`, `File or document <uuid> not found.` No `type` / `kind` field is added to
the envelope.

**Alternatives considered:**

- **Say "file"** (shortest, matches the command group). Rejected: it is a plain untruth roughly whenever
  the UUID points at a note, and this is a destructive command where the user's mental model of *what
  just disappeared* matters most.
- **Say "resource"** (accurate, kind-neutral). Rejected as CLI-speak — it tells a human nothing about
  what they just destroyed.
- **Resolve the kind with a `GET`/`files list` lookup before deleting and name it precisely.** Rejected:
  an extra round-trip per UUID, behind the same ACL, to improve one word of copy.

**Rationale:** `docs/api/freelo-api.yaml` :4497 says the endpoint resolves the type from the UUID
automatically, and the 200 body (:4514-4519) is a bare `SuccessResponse` with no kind information. The CLI
genuinely does not know which of the two it removed, so the copy says exactly that. Slightly clumsy
phrasing is the right trade against confidently naming the wrong noun. The same reasoning keeps a `type`
field out of the envelope (spec 0064 §4.2) — an agent that needs the kind reads it from `files list`
before deleting, where it is actually known.
