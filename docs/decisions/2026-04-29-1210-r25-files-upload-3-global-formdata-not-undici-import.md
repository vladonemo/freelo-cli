# Decision 3 — Use the **global** `FormData`, not `undici`'s exported `FormData`

**Run:** 2026-04-29-1210-r25-files-upload
**Phase:** implement
**Agent:** implementer (orchestrator-driven)

**Question:** The roadmap specifies the "undici FormData pattern". Should we `import { FormData } from 'undici'` or use the global `FormData` (which Node 20+ also provides via undici under the hood)?

**Decision:** Use the **global** `FormData` and `Blob`. Document the choice in `src/lib/multipart.ts` header.

**Alternatives considered:**

- `import { FormData } from 'undici'`. **Rejected after testing**: undici's `FormData` and `globalThis.FormData` are not the same class at the prototype level. When you pass undici's `FormData` to the global `fetch`, fetch does NOT recognize it as a multipart body — it falls back to `text/plain;charset=UTF-8` serialization. This is a real bug discovered during the test phase: my first implementation imported from `undici` and the upload was sent as plain text.

**Rationale:** Node's global `fetch` is implemented by undici, but the multipart-detection branch checks `instanceof globalThis.FormData`. To get a proper `multipart/form-data; boundary=…` request, the body must be a global `FormData`. The roadmap's "undici FormData pattern" wording was prescriptive about the API shape (the multipart-body mechanism), not literal about which named export to import. We honor the intent: standard FormData built into Node 20+, no `form-data` polyfill, no `busboy`.
