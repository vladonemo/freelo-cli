# freelo task-labels colors

List the task-label color palette the **Freelo server** accepts, and flag any drift from the local `--palette` name table the CLI ships. Maps to Freelo's `GET /task-label-colors` endpoint.

Read-only. No arguments, no flags of its own.

> **This command does not change how `--palette` works.** It is a check on the CLI's built-in table, not a replacement for it. See [Why the local table is still authoritative](#why-the-local-table-is-still-authoritative).

## Synopsis

```bash
freelo task-labels colors
```

`--output`, `--profile`, `-v`/`-vv`, `--request-id` are inherited global flags. There is no `--dry-run` and no confirmation gate.

## What each column means

```
COLOR     PALETTE   DISPLAY NAME   DEFAULT
#77787a   gray      Gray           yes
#15acc0   aqua      Aqua           -
#367fee   blue      Blue           -
```

| Column         | Meaning                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `COLOR`        | The hex value the server accepts. This is the only thing that ever goes over the wire as a label color.                                |
| `PALETTE`      | The name **you can type** into `--palette` to get that hex. `-` means the CLI has no name for this color — use `--hex` instead.        |
| `DISPLAY NAME` | Freelo's own label for the color. **Display only.** The API explicitly does not accept it as input, so it is not the `--palette` name. |
| `DEFAULT`      | `yes` on the color Freelo applies when a label is created without one.                                                                 |

`PALETTE` and `DISPLAY NAME` are two different things and will often look similar. Type the `PALETTE` one.

## Drift is data, not an error

The command exits **0** whether or not the local table matches the server. If they disagree, human output appends a footer:

```
Drift: the local --palette table does not match the server.
  Accepted by the server, no --palette name: #0abcde
    Use --hex <value> to apply one of these.
  Offered by --palette, not returned by the server: aqua
```

and JSON output carries the same information in `data.drift`. Nothing is broken when drift appears — it means this CLI version predates a palette change on Freelo's side. A color in `server_only` is still usable today via `--hex`; a name in `local_only` may now be snapped to something else by the server.

Making drift a non-zero exit would have been a new exit-code contract for a condition that is informational, so a script that wants to fail on drift reads the field:

```bash
# Fails the job when the shipped palette table has gone stale.
freelo task-labels colors --output json | jq -e '.data.drift.matches' > /dev/null
```

That is the intended use: a scheduled check, not something a human has to remember to eyeball.

## Examples

**See which name to type for a color you want.**

```bash
freelo task-labels colors
# then
freelo task-labels create --name "Blocked" --palette red
```

**Find the color Freelo will use if you don't pick one.**

```bash
freelo task-labels colors --output json | jq -r '.data.default_color'
# => "#77787a"
```

**Grab every hex the server accepts that this CLI has no name for.**

```bash
freelo task-labels colors --output json | jq -r '.data.drift.server_only[]'
# feed any of these to --hex
```

## Why the local table is still authoritative

`--palette` resolves its nine names from a table compiled into the CLI. It stays that way on purpose:

- **The server has no name vocabulary to adopt.** `display_name` is documented as display-only and is not accepted as input. The wire field is always the hex. Freelo is a Czech/Slovak product, and a display name that is localized per account would silently change which names `--palette` accepts depending on who is logged in.
- **Validation stays offline and free.** `--palette red` is checked locally in microseconds. Fetching the palette first would let `task-labels attach --palette red` fail with a 401, a 429, or a timeout before it even attempts the thing you asked for.
- **A stale table fails closed, and the escape hatch already exists.** If Freelo adds a color, the CLI will reject an unknown `--palette` name — but `--hex #NEWHEX` works immediately, with no upgrade. The reverse (a fetched table accepting something the server later rejects) would surface as a server error mid-write, with no workaround.

So: `--palette` for the nine known names, `--hex` for anything else, and this command to find out when the two sets have parted ways.

## Permissions

Requires only a valid API key. The palette is account-independent — there is no project scoping and no per-role visibility. Any authenticated caller sees the same list.

## Envelope

`schema: "freelo.task_labels.colors/v1"`

```json
{
  "schema": "freelo.task_labels.colors/v1",
  "data": {
    "colors": [
      { "color": "#77787a", "display_name": "Gray", "is_default": true, "palette_name": "gray" },
      { "color": "#0abcde", "display_name": "Teal", "is_default": false, "palette_name": null }
    ],
    "count": 2,
    "default_color": "#77787a",
    "drift": {
      "matches": false,
      "server_only": ["#0abcde"],
      "local_only": ["aqua", "blue", "green", "pink", "purple", "red", "orange", "yellow"]
    }
  },
  "rate_limit": { "remaining": 998, "reset_at": "2026-08-29T18:00:00Z" }
}
```

- `colors[].palette_name` — the local `--palette` name for that hex, or `null`. Case-insensitive match: the server sends lowercase hex, the CLI stores uppercase, and that difference alone is never reported as drift.
- `default_color` — lifted from whichever entry carries `is_default: true`, or `null` if none does.
- `drift.server_only` — hex values (there is no local name for them, by definition).
- `drift.local_only` — palette **names** (that is what you would have typed).

Not paginated. The endpoint takes no parameters and returns the whole palette in one response.

## Exit codes

| Code | When                                                           |
| ---- | -------------------------------------------------------------- |
| 0    | Success — **including when drift is reported**                 |
| 3    | Authentication failed (401)                                    |
| 4    | Server error (5xx), or a response body the CLI could not parse |
| 5    | Network failure                                                |
| 6    | Rate limited (429)                                             |

## See also

- [`freelo task-labels create`](./task-labels-create.md) — where `--palette` and `--hex` are used
- [`freelo task-labels find`](./task-labels-find.md) — list the labels themselves, not the palette
