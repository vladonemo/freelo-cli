# Triage — M06 `freelo task-labels merge`

**Run:** `2026-08-29-2050-m06-task-labels-merge`
**Phase:** 1 (triage)

## Tier: **Yellow**

Assigned on this slice's own signals, not on the roadmap's guess.

### Yellow triggers that fire

| Trigger (autonomous-sdlc.md §Yellow) | Holds? | Evidence |
|---|---|---|
| New user-visible command or flag (additive) | **yes** | `freelo task-labels merge` is a new leaf under an existing parent; `--from`, `--to`, `--dry-run` are new flags. |
| New field added to an envelope schema | **yes** (new schema, not a field) | `freelo.task_labels.merge/v1` is a brand-new envelope contract. Nothing existing is removed, renamed or retyped. |
| Changeset is `minor` | **yes** | New public command surface → minor. |
| New non-security dependency | no | No new deps. |
| New Medium security finding | pending | Security pass runs at review; see route flags. |

### Red triggers checked and **not** firing

- Does not touch `src/config/`, auth flows, `src/api/client.ts`, or TLS/retry/redirect defaults.
  The only `src/api/` change is a new endpoint wrapper module function in `src/api/task-labels.ts`.
- No breaking change: no flag removed, no exit code changed, no existing envelope field altered.
- No dependency removal or major bump.
- Changeset is not `major`.
- Requirement scope is unambiguous (the endpoint's contract is fully specified in the yaml, and
  the CLI shape is given). The three design questions are UX choices with codebase precedent —
  `autonomous-sdlc.md` §"Autonomous decisions vs. pauses" classifies those as *decide and log*,
  not pause.

### Green explicitly rejected

Green requires "no new user-visible command", which this slice violates outright, so Green is
unreachable on the rules as written. Recording it anyway because the requirement asked for it to
be flagged loudly: **auto-merge would be inappropriate here on the merits regardless of the
rulebook.** This command performs an irreversible bulk relabel across every task in the caller's
account that carries a source label, the API exposes no undo endpoint, and no `task-labels delete`
endpoint exists to clean up afterwards. The blast radius is unbounded from the CLI's point of view
and unobservable in the response. A human takes the merge decision.

## Route flags

```json
{
  "tier": "Yellow",
  "needsSecurityReview": true,
  "requiresFreeloApi": true,
  "preApprovedDeps": [],
  "allowNetwork": false,
  "autoShip": false
}
```

- `needsSecurityReview: true` — not because of `src/config/` or auth (untouched), but because the
  slice's safety property *is* a security-shaped boundary: fail-closed confirmation on a
  destructive bulk write, and no secret leakage through the new 404 error-rewrite path. Scope the
  audit to those two things.
- `requiresFreeloApi: true` — contract verification against `docs/api/freelo-api.yaml` is the
  first substantive step, and the roadmap's behaviour notes are explicitly untrusted.
- `allowNetwork: false` — MSW only. No live call is made at any point in this run.

## Route

Full pipeline: spec → plan → implement → test → review → security → document → PR. **Stop before
merge.**
