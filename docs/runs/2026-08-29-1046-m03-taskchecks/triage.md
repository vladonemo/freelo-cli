# Triage — 2026-08-29-1046-m03-taskchecks

**Tier:** Yellow
**Commit type:** feat

## Summary

Add a new top-level resource `freelo taskchecks` with four write subcommands — `edit`, `delete`, `finish`, `reopen` — wrapping `POST /taskcheck/{id}`, `DELETE /taskcheck/{id}`, `POST /taskcheck/{id}/finish` and `POST /taskcheck/{id}/activate`. These manage *simple* checklist items (`tasks_checks` rows), the lightweight fallback form R14 can create but never gave a way to manage afterwards. No existing command's behavior changes.

## Signals

- [x] Touches `src/commands/` (four new subcommands on a new resource)
- [x] Touches `src/api/` (new wire wrappers + new zod schemas)
- [ ] Touches `src/config/`
- [ ] Touches `src/api/client.ts` or HTTP defaults
- [ ] Touches auth flows
- [ ] Adds a dependency
- [ ] Removes a dependency
- [x] Changes an envelope schema — **four brand-new** schemas (`freelo.taskchecks.{edit,delete,finish,reopen}/v1`). No existing schema field is removed, renamed or retyped.
- [ ] Changes exit codes (reuses the established `ValidationError`=2 / `ConfirmationError`=2 / `FreeloApiError` mapping)
- [ ] Removes/renames an existing flag
- [x] Requires the Freelo API
- [ ] Docs-only

## Route flags

- requiresFreeloApi: **true**
- needsSecurityReview: **false**
- preApprovedDeps: **[]**
- allowNewDeps: **false**

`needsSecurityReview` is false on the `sdlc.md` Phase 5 rule (required only for changes touching `src/config/` or auth flows). This slice reads credentials through the existing `resolveCredentials` helper without modifying it, adds no secret storage, and introduces no new logging of request bodies. The destructive `delete` subcommand is a **confirmation-gate** concern, which `code-reviewer` covers under "Writes are agent-safe", not a security-auditor trigger.

## Rationale

Yellow, not Green: "New user-visible command or flag (additive)" and "New field added to an envelope schema" are each explicit Yellow triggers, and this slice fires both four times over plus a `minor` changeset. The M04 correction recorded at `docs/roadmap-migration-2026-08.md:123` applies directly — additive-and-safe does not pull a slice down to Green.

Yellow, not Red: nothing here touches `src/config/`, auth flows, `src/api/client.ts`, or TLS/retry/redirect defaults; there is no breaking change, no dependency movement, and no `major` changeset.

## The id-space question is NOT a Red trigger — argued, not assumed

The requirement flags an unresolved design question (smart vs. simple taskcheck id spaces; auto-probe vs. user-picks) and the Red tier includes "Requirement itself is ambiguous about scope or UX" and "Spec has unresolvable Open questions". I assessed it as **resolvable at spec time** for three reasons:

1. **Scope is not ambiguous.** The CLI surface is fully specified down to flag names in the requirement and the roadmap. The open question is about *internal dispatch strategy behind an already-fixed surface* — under either option (a) or (b) the four commands, their names, their arguments and their flags are identical. Option (b) would only change what happens on a 404. That is a behavior decision inside a settled UX, not scope ambiguity.
2. **The requirement delegates it explicitly and supplies the evaluation criteria.** It names both options, names the cost of each (UX cost of user-picks vs. correctness cost of auto-probing), and states a leaning. `autonomous-sdlc.md` §"Autonomous decisions vs. pauses" routes "small UX choices with a clear precedent in the codebase" to decide-and-log. The precedent exists: `src/commands/files/delete.ts:37-50` (M07) and M01 both already decided the structurally identical question — "may the CLI absorb this endpoint's 404 into a different outcome?" — and both answered no.
3. **The API contract is determinate.** `docs/api/freelo-api.yaml:2124,2161,2179,2212` states the 404-on-smart-id behavior in prose on all four operations. This is not a case of "API behavior not in the yaml" (which *would* mandate a pause). The architect has the facts needed to decide.

The architect must still record the decision with alternatives and rationale per the decision-log protocol, and the PR body must flag it for human review. If the architect finds it *cannot* be decided on the evidence, it should raise it as an Open question and the run pauses then — but it should not pause preemptively at triage.

## Open concerns for the architect

1. **Verify `notify_author` per-endpoint, do not assume it is uniform.** The requirement asserts all four endpoints accept it. A read of the yaml suggests otherwise — check `requestBody` presence on each of the four operations individually and let the OpenAPI contract win (`autonomous-sdlc.md` §Failure modes: "Spec says something the OpenAPI spec contradicts → Freelo's contract is authoritative"). A flag that silently does nothing on two of four subcommands would be worse than not offering it there.
2. **Re-derive idempotency per endpoint.** Do not inherit R11's `already_in_target_state` pattern wholesale. Check specifically whether a single taskcheck's state is *readable* at all — R11's pattern depends on a pre-check GET, and there is no `GET /taskcheck/{id}` in the yaml. If prior state is unobservable, the CLI must not fabricate it.
3. **404 absorption policy** must be decided per endpoint against the yaml's own words, not by pattern-matching to M01/M07. Note the taskcheck 404 carries a meaning those two did not: "you handed us an id from the other id space."
4. **Edit surface is deliberately small** — `--name` and `--worker`/`--clear-worker` only. Do not import R10's flag set.
5. Confirm the next free spec number (0065 is the highest currently in `docs/specs/`).

## Recommended branch name

`feat/taskchecks`

---

`TRIAGE run=2026-08-29-1046-m03-taskchecks tier=Yellow type=feat flags=[requiresFreeloApi]`
