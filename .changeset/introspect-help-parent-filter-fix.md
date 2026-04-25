---
'freelo-cli': patch
---

Fix `freelo help <parent-group> --output json` so it returns the introspect
envelope scoped to the parent's subtree instead of failing with
`VALIDATION_ERROR: Unknown command '<parent>'` exit 2.

Previously the filter did an exact-match against `commands[].name`, but the
introspect data only stores leaves — so any non-leaf path (`help config`,
`help auth`) errored out. The filter now matches both leaves and parent-group
prefixes, returning every leaf under the requested subtree. Existing leaf and
unknown-path behavior is unchanged. The `freelo.introspect/v1` envelope schema
is unchanged (no schema bump).
