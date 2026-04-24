---
description: Resume a paused autonomous run. Reads the pause report, applies the human's answer, and re-enters the paused phase via the orchestrator.
argument-hint: <run-id> <answer>
---

You are resuming a paused autonomous SDLC run.

Input: $ARGUMENTS

## What to do

1. Parse $ARGUMENTS as `<run-id> <answer>`. The answer may be a single letter (A/B/C) matching a listed option, or free-form text.
2. Read `docs/runs/<run-id>/pause.md`. If it doesn't exist, stop — nothing to resume.
3. Append the answer to `docs/runs/<run-id>/phase-reports/<pause-phase>-resume.md`:

   ```markdown
   # Resume — <timestamp>

   **Paused at:** <phase>
   **Question:** <from pause.md>
   **Answer:** <the user's answer, verbatim>
   **Interpretation:** <how the orchestrator will apply it>
   ```

4. Determine the interpretation:
   - If the answer changes scope (e.g., "actually don't add that flag"), the orchestrator re-runs **triage + spec** with the updated requirement.
   - If the answer resolves an Open question in the spec, edit the spec and continue from the paused phase.
   - If the answer is "abort", delete the branch (after confirming with the user if uncommitted work), mark the run closed, and stop.

5. Spawn the `orchestrator` agent with:
   - The `run-id`
   - A resume payload: which phase to re-enter, what the answer was, how it was interpreted
6. Let the orchestrator continue. Stream its output.

## Hard rules

- **Don't overwrite** `pause.md` — create the resume report as a new file.
- **Don't silently reinterpret** the human's answer. If the answer is ambiguous, stop and ask before resuming.
- **Don't skip phases**. Re-entering at phase N means phases N..end run in order.
- **Don't auto-merge** a PR that was already open when paused until the orchestrator explicitly reaches the merge gate again.

## Output format

```
/resume <run-id>
  paused at: <phase>
  answer: <short>
  interpretation: <short>

[orchestrator continues]
```

If the run completes after resume, the final summary is the same format as `/auto`.
