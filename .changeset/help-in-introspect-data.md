---
'freelo-cli': minor
---

Include the `help` subcommand in `freelo --introspect` (and in `freelo help --output json`) `data.commands`. Previously omitted by design; now enumerated symmetrically with every other public command, with `output_schema: "freelo.introspect/v1"` (self-referential — `freelo help --output json` emits exactly that envelope). Additive content change to the `freelo.introspect/v1` envelope; no shape change. README autogen Commands block regenerated to include the new row. (Spec 0008.)
