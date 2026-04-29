# Triage — R25 `freelo files upload`

**Run:** 2026-04-29-1210-r25-files-upload
**Tier:** **Yellow**
**Date:** 2026-04-29

## Tier rationale

R25 is a new user-visible command (`freelo files upload`) that adds:
- New subcommand tree (`files`)
- New API operation (`POST /file/upload` multipart)
- New shared helper (`src/lib/multipart.ts`) — first use of multipart in the codebase
- New additive method on `HttpClient` (`requestMultipart`) — does NOT change existing `request()` defaults, retry, auth, or redirect behavior

**Yellow triggers met:**
- New user-visible command/flag (additive) — primary trigger
- Changeset will be `minor`
- Adds new envelope schema `freelo.files.upload/v1`

**Red triggers considered, ruled out:**
- "Touches `src/api/client.ts`": the change is **additive** (a new `requestMultipart` method that reuses auth header construction). Existing `request()` retry/auth/redirect defaults are untouched. The Red rule's intent is to gate changes to default transport behavior, not all edits to the file. **Will be flagged in PR body** for human review (autonomous-sdlc.md "New user-facing flag name or short form" → "Decide, log, flag for review in PR body").
- "Storage of a new secret": no — multipart bodies don't introduce new credential surface.
- "Breaking change": no — purely additive.
- "API behavior not in OpenAPI": **partially** — see the spec ambiguity below; resolved by decision-log entry, not pause.

## Spec ambiguity (resolved without pause)

The OpenAPI spec at `docs/api/freelo-api.yaml`:
- L3867–3907 documents `POST /file/upload` returning `{ uuid: format: uuid }`.
- L3876 documents the only documented attach mechanism: embedding `<a data-freelo-uuid="{uuid}">caption</a>` in comment content.
- L5563–5572 defines a `FileUpload` schema requiring `download_url` — used by comment/description endpoints. This contradicts the upload response which only returns `uuid`.

The API itself is the authority. We have two facts:
1. Upload returns a uuid.
2. The documented way to attach to a task is via comment content with the `<a data-freelo-uuid>` anchor.

The roadmap's `--attach-to-task <id>` flag therefore translates to: upload all files, then `POST /task/{task_id}/comments` with content containing `<a data-freelo-uuid="{uuid}">filename</a>` for each upload. This is the only documented mechanism. Decision logged separately.

## Route flags

```
needsSecurityReview:    false  (no auth/config/secret changes)
requiresFreeloApi:      true   (new endpoint)
preApprovedDeps:        []     (no new deps; uses undici FormData built-in)
breakingChange:         false
schemaBump:             new    (freelo.files.upload/v1 — new schema, not a bump)
```

## Pre-approved dependencies

None. The roadmap explicitly says "multipart body helper (`undici` `FormData` pattern)" — `undici` is already a dep, `FormData` is built into Node 20+. No new deps may be added without pausing.

## What runs through to PR

Full pipeline: spec → plan → implement → test → review → docs → commit/push/PR. **Stop at PR open.** Human reviews the additive `client.ts` change and the multipart helper before merge.
