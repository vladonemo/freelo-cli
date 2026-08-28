# Decision 6 — Don't assert wire-level request counts; MSW double-invokes resolvers here

**Run:** 2026-08-28-2039-files-delete
**Phase:** test / review
**Agent:** orchestrator (executing the `test-writer` + `code-reviewer` mandates)

**Question:** Spec 0064 §5.4 says duplicate UUIDs are not de-duplicated (first DELETE succeeds, second
404s). A test written to prove it with a stateful handler asserted `calls === 2` and observed **4**.
Is the command issuing duplicate DELETE requests, and how should §5.4 be tested?

**Decision:** The command is fine — the doubling is an MSW interception artifact in this repo's test
environment. Assert §5.4 at the **envelope** level (two input items → two output envelopes, nothing
collapsed) and never at the wire-request-count level.

**Alternatives considered:**

- **Treat it as a real bug and pause the run.** Correctly rejected after investigation, not assumed —
  see rationale. Pausing on it would have been a false alarm.
- **Keep the `calls === 2` style assertion but expect 4.** Rejected: it hard-codes a mock's quirk into a
  product test, and silently breaks whenever MSW's interception changes.
- **Use `http.*.once()` handlers to sidestep the state problem.** Rejected — with the resolver firing
  twice per logical request, `.once()` makes the *second* interception fall through to
  `onUnhandledRequest: 'error'`, which is worse.

**Rationale:** Investigated rather than guessed, because "a destructive command fires DELETE twice" would
be a serious finding. Three probes, escalating in isolation:

1. `files delete <uuid> --yes` → 2 resolver invocations for 1 logical delete.
2. The **already-shipped** `comments delete <id> --yes` (M01) → also 2. So not introduced by this slice.
3. A bare `await fetch(url, { method: 'DELETE' })` with **no CLI code in the call path at all** → also 2
   resolver invocations and 2 `request:start` events.

Probe 3 is decisive: with no product code involved, the duplication can only come from the mock layer
(MSW's node interception paths both observing the same underlying request). The CLI issues one DELETE.

Worth knowing repo-wide: any existing or future test asserting "exactly N requests reached the server"
is measuring the interceptor, not the code. This slice's tests assert observable output — envelopes,
exit codes, messages — which is the contract that actually matters anyway. Candidate for a calibration
entry if another slice trips on it.
