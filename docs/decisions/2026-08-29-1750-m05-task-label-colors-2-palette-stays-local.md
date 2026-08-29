# Decision 2 — The hardcoded PALETTE stays authoritative; `colors` ships alongside it

**Run:** 2026-08-29-1750-m05-task-label-colors
**Phase:** spec
**Agent:** orchestrator (architect mandate)

**Question:** Does `freelo task-labels colors` replace the hardcoded nine-name `PALETTE` in `src/lib/label-color.ts` (fetched live, cached with a TTL), or ship as a read-only discovery command alongside it, leaving the hardcoded table as the offline-safe default?

**Decision:** Alongside. `PALETTE` remains the sole validator for `--palette` on every command that accepts a colour — offline, synchronous, free, unchanged. `colors` is a discovery and drift-check surface with no runtime relationship to `--palette`.

**Alternatives considered:**

- **Replace, fetched live per `--palette` use.** Adds an authenticated network round-trip to previously-local validation.
- **Replace, fetched live with a TTL cache.** Same failure modes, made intermittent, plus cache state to design, persist, invalidate and test.
- **Alongside, but as a bare list with no comparison.** The roadmap's literal suggestion.

**Rationale:** Four things, the first of which is on its own decisive. (1) **The server publishes no input vocabulary to adopt** — `TaskLabelColor.display_name` is documented "for display only; not accepted as input" (`docs/api/freelo-api.yaml` :5968); the only value that crosses the wire is the hex. A replace design would still map names client-side, but against server-supplied display names, which on a Czech/Slovak product may be localised — turning a deterministic flag surface into a per-account, per-locale one. (2) **Fail-closed is cheap here because the escape hatch already exists**: a stale table rejects a name, and `--hex #NEWHEX` reaches any colour the server accepts, today, with no upgrade; fail-open has no equivalent hatch and surfaces as a server 400/422 mid-write. (3) A live fetch imports 401/429/timeout/TLS failures into a path whose only current failure is a `ValidationError` the user can act on. (4) Nine values the contract calls "the fixed palette" do not justify a cache-invalidation design.

The third alternative was rejected on the outcome, not the mechanism: the roadmap's stated goal is "the CLI stops silently drifting", and a human comparing two nine-row tables by eye is the process that lets drift go unnoticed. The envelope therefore carries the comparison (`data.drift`), which makes the check a one-line scheduled job without adding a flag, a mode, or an exit code. Full argument in spec 0067 §6.
