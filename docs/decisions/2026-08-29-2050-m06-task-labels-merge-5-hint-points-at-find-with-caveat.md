# Decision 5 — The 404 hint points at `task-labels find`, and says it is a superset

**Run:** 2026-08-29-2050-m06-task-labels-merge
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** Is a `hint_next` pointing at `task-labels find` (M04) warranted on the not-found path?

**Decision:** Yes, and it explicitly states that `find` lists a **superset** of the labels the
caller owns, so it can show a label merge will still reject.

**Alternatives considered:**

- Point at `find` without the caveat. Rejected: `GET /task-labels/find-available` returns labels
  usable across the caller's owned **and invited** projects (yaml :2847), while merge requires
  ownership. An unqualified pointer sends the user in a circle — `find` shows the label, merge
  keeps answering 404, and nothing explains the gap.
- Add a pre-flight `find` call inside merge to check the uuids before POSTing. Rejected: it cannot
  answer the question (visibility is not ownership), it adds a read to every invocation, and it
  would produce a *more* confident wrong answer than no check at all.
- No hint. Rejected: `find` is the only uuid-discovery surface in the CLI and this whole slice
  presumes it.

**Rationale:** A hint that points somewhere useful while naming its own limits beats both silence
and false confidence.
