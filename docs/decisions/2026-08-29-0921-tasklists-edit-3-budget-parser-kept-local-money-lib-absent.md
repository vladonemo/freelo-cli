# Decision 3 — Budget parser kept local to the command; `src/lib/money.ts` does not exist

**Run:** 2026-08-29-0921-tasklists-edit
**Phase:** 2 (spec)
**Agent:** orchestrator (inline)

**Question:** The roadmap and the requirement both say to "reuse `src/lib/money.ts` (R22) if the encoding matches; verify first". Does it match?

**Decision:** **`src/lib/money.ts` does not exist.** The roadmap claim is refuted. The budget flag parser is implemented **locally** in `src/commands/tasklists/edit.ts`, semantically identical to `parseBudgetFlag` in `src/commands/tasklists/create.ts:56-65` (`^[0-9]+$`, verbatim string passthrough, no client-side arithmetic). No shared module is extracted in this slice.

**Evidence:** `src/lib/` contains `batch, confirm, dry-run, env, filename, format, idempotency, input, introspect, iso-timestamp-future, iso-timestamp, label-color, logger, multipart, parse-fields, query, request-id, stdin, version` — no `money.ts`. A case-insensitive grep for `money|minor currency|minor unit|MinorUnit` across `src/` matches only four doc-comments on **response-side** `CurrencySchema` declarations (`src/api/schemas/{project,report,task,tasklist}.ts`), which normalize an incoming `amount: string|number` to a string. Those are parsers for responses, not encoders for requests, and are not reusable here.

**Alternatives considered:**

- Create `src/lib/money.ts` now and refactor `tasklists create` onto it — two call sites is the usual threshold for extraction.
- Import `parseBudgetFlag` directly from `src/commands/tasklists/create.ts` (command-to-command import).

**Rationale:** The repo has an explicit, repeated convention against premature helper-sharing: `src/commands/tasks/edit.ts:120-123` ("copied here intentionally rather than shared, because ... the helper has no other callers yet"), `src/api/schemas/tasklist.ts:33-34` and `:91-93` ("Pulling these into a shared module is deferred to a follow-up refactor"), and M07 decision 4 ("uuid parser kept local"). Extracting a lib would also mean editing `tasklists create` — a shipped command — inside a slice whose job is to add a new one, converting a zero-risk addition into a small regression surface for no functional gain. Command-to-command imports are rejected outright: they invert the dependency direction the architecture assumes (`src/commands/` depends on `src/api/` and `src/lib/`, never on a sibling command).

**Follow-up flagged, not done:** the extraction is now genuinely warranted (two real call sites with identical semantics). Worth its own `chore/` slice that moves both and adds unit tests for the shared helper. Recorded here so the *next* slice does not re-run this same investigation — and so the caution in `.claude/skills/freelo-api/SKILL.md` §Currency encoding ("verify this interpretation with a real response before wiring a money-facing command") is answered as far as it can be without network: the interpretation is confirmed verbatim by the OpenAPI text for `editTasklist`, quoted in `docs/runs/2026-08-29-0921-tasklists-edit/triage.md`. It has **not** been confirmed against a live response, because this run is `allowNetwork: false`.
