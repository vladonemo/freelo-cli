---
'freelo-cli': patch
---

fix(api): notifications — match real Freelo wire shape

Two divergences between the published OpenAPI spec and the live Freelo API
were caught after R28 shipped:

- `GET /all-notifications?only_unread=...` requires the string `"1"` / `"0"`,
  not the documented boolean. The server silently ignored `true` so
  `freelo notifications list --unread` returned the same list as without
  the flag.
- The mark endpoints are `/notification/{id}/mark-read` and `/mark-unread`,
  not `/mark-as-read` / `/mark-as-unread` as the spec says. The longer
  paths returned 200 but did not flip the flag.

Both verified against Freelo's official MCP server
(github.com/freeloapp/mcp). The cached OpenAPI yaml has been corrected
and a "known quirks" entry added to the freelo-api skill.
