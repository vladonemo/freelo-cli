---
'freelo-cli': minor
---

Add `freelo projects show <id> [--with workers]`, the second slice of Wave 1
(R04). Single-resource fetch with optional side-cars; introduces the `--with`
flag plumbing every later show-style command will inherit.

New public envelope schema: `freelo.projects.show/v1`. The `data.project`
payload is the rich `ProjectDetail` shape (extends `ProjectFull` with
embedded `tasklists[*].tasks` and `workers[*].hour_rate`). When `--with
workers` is set, `data.workers` carries the canonical paginated worker list
(`UserBasic[]`, no `hour_rate`); absent otherwise.

`<id>` validates as a positive integer before any HTTP call. Unknown
`--with` values exit 2 with a `hint_next` listing valid values. 404 and
403 from `/project/{id}` map to `FREELO_API_ERROR` (exit 4) with friendlier
hints distinguishing "not found / no access" from "no permission".

**`--with labels` not shipped.** The original roadmap promised it, but
Freelo's documented API has no per-project labels read endpoint; only
workspace-scoped labels are exposed. Tracked as a non-goal in spec 0013;
will land when Freelo exposes the endpoint or we audit a real account for
an undocumented one.
