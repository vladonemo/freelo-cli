# freelo labels list

List the caller's available project labels — their private labels plus public labels from any accessible project. Maps to Freelo's `GET /project-labels/find-available` endpoint.

## Synopsis

```bash
freelo labels list [--output <mode>]
```

## Options

| Flag       | Type / values | Default | Purpose                                      |
| ---------- | ------------- | ------- | -------------------------------------------- |
| `--fields` | comma list    | (all)   | Field-projection helper for the JSON output. |

`--output`, `--color`, `--profile`, `-v`/`-vv`, `--request-id` are inherited global flags.

> v1 ships **no `--project` filter**. The documented endpoint accepts no query parameters and the `ProjectLabel` response shape carries no `attached_projects` field, so there is no documented way to list "labels attached to project X" without a separate call. Tracked as future slice R23.5. (See spec 0035 decision 03.)

## Permissions

- API key with read access. The endpoint is ACL-filtered: callers see their own private labels plus public labels from projects they can access.

## Envelope

`schema: "freelo.labels.list/v1"`

```json
{
  "schema": "freelo.labels.list/v1",
  "data": {
    "labels": [
      {
        "id": 12,
        "name": "Billable",
        "color": "#9b59b6",
        "is_private": false,
        "users_id": 42,
        "usage_count": 7,
        "can_be_public": true,
        "can_be_edited": true
      }
    ]
  },
  "rate_limit": { "remaining": 999, "reset_at": "..." }
}
```

No `paging` field — the endpoint is single-shot.

## Examples

### Inventory in JSON (agent)

```bash
$ FREELO_API_KEY=... FREELO_EMAIL=... freelo labels list --output json
{"schema":"freelo.labels.list/v1","data":{"labels":[{"id":12,"name":"Billable","color":"#9b59b6","is_private":false,"users_id":42,"usage_count":7}]}}
```

### Human table (TTY default)

```bash
$ freelo labels list
ID    NAME       COLOR    PRIVATE  USAGE
----  ---------  -------  -------  -----
12    Billable   #9b59b6  no       7
13    On hold    #ff0000  yes      0
```

## Errors

| Trigger               | Code               | Exit |
| --------------------- | ------------------ | ---- |
| Bad credentials (401) | `AUTH_EXPIRED`     | 3    |
| Server error (5xx)    | `SERVER_ERROR`     | 4    |
| Rate-limited (429)    | `RATE_LIMITED`     | 6    |
| Network failure       | `NETWORK_ERROR`    | 5    |
| Malformed wire body   | `VALIDATION_ERROR` | 4    |

## See also

- `freelo labels rename` — rename / recolor / toggle private on an existing label.
- `freelo labels attach` — attach (fetch-or-create) a label to a project.
