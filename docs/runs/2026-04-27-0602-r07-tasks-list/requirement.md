# R07 — `freelo tasks list`

**Source:** `docs/roadmap.md` lines 172–188.

**Outcome:** The workhorse read — filter tasks across all accessible projects.

**Endpoints:**
- `GET /all-tasks`
- `GET /project/{project_id}/tasklist/{tasklist_id}/tasks`
- `GET /tasklist/{tasklist_id}/finished-tasks`

**CLI:**

```
freelo tasks list [--project <id>]... [--tasklist <id>]... [--worker <id>]
                  [--state <id>] [--label <name>]... [--without-label <name>]
                  [--due-from YYYY-MM-DD] [--due-to YYYY-MM-DD] [--no-due]
                  [--finished-overdue] [--finished-from ...] [--finished-to ...]
                  [--search <text>] [--order-by priority|name|date_add|date_edited_at]
                  [--order asc|desc] [--page N|--all] [--fields ...]
```

**Ships with this slice:**
- `src/lib/query.ts` — encodes array params as `projects_ids[]=...` repeating, not PHP-brackets-in-key.
- Explicit handling of the `with_label` (deprecated, singular) vs `with_labels[]` merge quirk — CLI normalizes to the array form.

**Depends on:** R03.

## Run constraints
- allowNetwork: false (MSW only)
- autoShip: false (no `/ship`, no npm publish)
- Budget: defaults (30 min wall, 40 agent calls, 8 retries, 25 files)
- Risk-tier hint: at least Yellow (new user-visible command, new envelope schema, new shared lib).
