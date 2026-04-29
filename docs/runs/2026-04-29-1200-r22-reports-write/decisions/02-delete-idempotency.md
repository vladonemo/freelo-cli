# Decision 02 — `reports delete` second-delete idempotency heuristic

**Run:** 2026-04-29-1200-r22-reports-write
**Phase:** Spec (Phase 2)
**Agent:** orchestrator (resolving Phase 2 pause via human answer "A")

## Question

OpenAPI does not document the second-delete behavior of `DELETE /work-reports/{id}`. What does the CLI surface as `already_in_target_state: true`, and what does it surface as a hard error?

## Decision

Mirror `src/commands/tasks/delete.ts:415-431` precedent with one extension for the documented 400 ACL marker. Four arms:

| Wire response                                           | CLI behavior                              |
| ------------------------------------------------------- | ----------------------------------------- |
| HTTP 404 (any body)                                     | `already_in_target_state: true`, exit 0   |
| HTTP 400, body matches `/not found\|does not exist/i`   | `already_in_target_state: true`, exit 0   |
| HTTP 400, body contains `UserCannotDeleteWorkReport`    | hard `FreeloApiError`, exit 4 (ACL)       |
| Any other non-2xx                                       | hard `FreeloApiError`, exit code per code |

The body-string heuristic is documented as a v1 best-effort: if a future Freelo build changes the message, capture a fixture and revisit. Tests cover all four arms with explicit MSW handlers.

## Alternatives considered

- **404-only idempotency (R13 minimum).** Would miss the documented Freelo pattern of returning 400 with "not found" text on second-delete (observed in tasks/delete and comments/delete fixtures). Too strict; agents would see spurious errors.
- **Treat all 400 as idempotent.** Would swallow the `UserCannotDeleteWorkReport` ACL case — the user lost rights mid-flow and the agent needs to know.
- **Pre-flight GET to check existence.** Doubles round-trips on a destructive op (R13 explicitly rejected this in spec 0024 decision 4). No benefit.

## Rationale

The four-arm matrix is the smallest set that distinguishes "the resource is gone" (idempotent skip) from "you're not allowed" (observable failure). Calibration rule 4 requires every new catch arm to have a dedicated test case — Phase 4 covers all four.
