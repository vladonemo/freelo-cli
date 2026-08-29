# freelo task-labels merge

Merge one or more source task labels into a target label in a single server-side call. Every task carrying a source label ends up carrying the target label instead. Maps to Freelo's `POST /task-labels/merge` endpoint.

> **This is the most destructive command in the CLI.** It relabels an unbounded number of tasks across your whole account in one call, and Freelo exposes **no undo endpoint**. Read [What it does not tell you](#what-it-does-not-tell-you) before running it against real data, and use `--dry-run` first.

## Synopsis

```bash
freelo task-labels merge --from <uuid> [--from <uuid> ...] --to <uuid> [--yes] [--dry-run]
```

| Flag            | Required | Meaning                                                                                                                          |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `--from <uuid>` | yes, ≥ 1 | UUID of a label to merge away. Repeatable, and each occurrence may itself carry a comma- or space-separated list.                |
| `--to <uuid>`   | yes, one | UUID of the label that survives. Its name and color are **not** changed by this call — they are whatever that label already had. |
| `--dry-run`     | no       | Print what would be sent. Makes no request, reads no credentials, and does not prompt.                                           |
| `--yes` / `-y`  | no       | Global flag. Bypasses the confirmation prompt. Required in non-interactive contexts.                                             |

`--output`, `--profile`, `-v`/`-vv`, `--request-id` are inherited global flags.

Both `--to` and every `--from` label must be **owned by you**. Labels you do not own answer `404`, not `403` — Freelo hides their existence rather than admitting you lack access.

## What it does not tell you

Two limits are baked into the endpoint, and both are invisible in the response. They are the reason this page exists.

### 1. Only projects where you are a commander are touched

Freelo applies the replacement **only to tasks in projects where you are a commander**. A task in a project where you have lesser access silently keeps the old label.

The API returns `{"result": "success"}` and nothing else — no task count, no list of what moved, no count of what was skipped. So the CLI cannot tell you how much of the merge actually landed, and it does not pretend to: **the success envelope reports what was sent, never what was changed.** There is no `tasks_updated` field, and there never will be one, because there is nothing to populate it from.

What the envelope does carry is a constant marker so an automated consumer cannot mistake success for completeness:

```json
"scope": "commander_projects"
```

If completeness matters to you, verify afterwards with [`freelo tasks list`](./tasks-list.md) per project, or re-run [`freelo task-labels find`](./task-labels-find.md) and check whether the source labels still appear on tasks you care about.

### 2. The source labels are not deleted

The merge detaches the source labels from tasks. It does **not** delete their definitions. After a successful merge the source labels still exist in your account, attached to nothing, and Freelo's own label picker will still offer them.

There is no way to remove them. The Freelo API exposes no delete endpoint for task labels at all — `DELETE /project-labels/{labelId}` exists, but that is a different resource (project labels, served by `freelo labels`). So this is not a missing follow-up step in the CLI; it is a permanent property of the API. Leftover empty labels after a merge are expected.

## Confirmation

Merging is gated the same way every destructive command in this CLI is gated:

| Situation                        | Behaviour                                                              |
| -------------------------------- | ---------------------------------------------------------------------- |
| `--yes` passed                   | Proceeds immediately.                                                  |
| `--dry-run` passed               | Proceeds without prompting — there is nothing destructive to gate.     |
| Interactive terminal, no `--yes` | Prompts once. The default answer is **no**; pressing Enter aborts.     |
| Non-interactive, no `--yes`      | Fails closed: `CONFIRMATION_REQUIRED`, exit **2**, no request is made. |

The prompt names the target and the irreversibility:

```
Merge 3 labels into 9f9f5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f? Every task carrying them is
relabeled. This cannot be undone. (y/N)
```

## Examples

**Preview first.** No request, no prompt, no credentials read — safe to run anywhere.

```bash
freelo task-labels merge \
  --from 0d0d5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f \
  --from 1e1e5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f \
  --to   9f9f5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f \
  --dry-run --output json
```

```json
{
  "schema": "freelo.task_labels.merge/v1",
  "dry_run": true,
  "data": {
    "to_uuid": "9f9f5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f",
    "from_uuids": ["0d0d5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f", "1e1e5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f"],
    "count": 2,
    "scope": "commander_projects",
    "would": {
      "method": "POST",
      "path": "/task-labels/merge",
      "body": {
        "from_uuids": [
          "0d0d5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f",
          "1e1e5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f"
        ],
        "to_uuid": "9f9f5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f"
      }
    }
  }
}
```

**Consolidate three spellings of the same label.** `bug`, `Bug` and `BUG` are three distinct labels as far as Freelo is concerned — label matching on create is case-sensitive and color-qualified, so duplicates are what the API produces, not a sign of misuse.

```bash
freelo task-labels merge \
  --from 0d0d5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f \
  --from 1e1e5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f \
  --to   9f9f5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f \
  --yes
```

```
Merged 2 labels into 9f9f5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f.

Scope: only tasks in projects where you are a commander are relabeled. Tasks in
other projects keep the old label, and the API reports no per-task detail — so
neither this command nor Freelo can tell you how many were skipped.

The source label definitions still exist; only their task attachments moved.
Freelo exposes no endpoint to delete a task label, so they stay in your account.
```

**Drive it from `task-labels find`.** A single `--from` accepts a comma-separated list, so a pipeline does not need shell argument fan-out:

```bash
freelo task-labels merge \
  --from "$(freelo task-labels find --output json \
    | jq -r '.data.labels[] | select(.name | ascii_downcase == "bug") | .uuid' \
    | grep -v 9f9f5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f \
    | paste -sd,)" \
  --to 9f9f5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f --yes
```

Note the `grep -v`: the target must not appear in `--from`. A self-merge is rejected client-side with exit 2 rather than sent.

## Input rules

- `--from` accepts a uuid, or several — `--from a --from b` and `--from a,b` are equivalent.
- Duplicate sources are de-duplicated before the call, including uuids that differ only in hex case. `--from A --from a` sends one entry.
- `--to` must not also appear in `--from`. The API does not define what a self-merge means and the CLI will not find out on your data.
- Label **names** are not accepted. Merge takes uuids only — resolving `bug` to a uuid is [`freelo task-labels find`](./task-labels-find.md)'s job, and picking one of three same-named labels for you is exactly the ambiguity this command exists to remove.

## Output

```json
{
  "schema": "freelo.task_labels.merge/v1",
  "data": {
    "to_uuid": "9f9f5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f",
    "from_uuids": ["0d0d5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f"],
    "count": 1,
    "scope": "commander_projects"
  },
  "rate_limit": { "remaining": 998, "reset_at": "2026-08-29T18:00:00Z" }
}
```

- `from_uuids` / `count` — the de-duplicated source list that was sent, in input order.
- `scope` — always `"commander_projects"`. It restates the endpoint's contract, not a measurement of this call.
- `would` — present only under `--dry-run`.

## Exit codes

| Code | When                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------- |
| 0    | The call was accepted                                                                                      |
| 2    | Bad input (missing/malformed `--from` or `--to`, self-merge), or confirmation required and not given       |
| 3    | Authentication failed (401)                                                                                |
| 4    | Label not found or not owned by you (404), forbidden (403), server error (5xx), or an unparseable response |
| 5    | Network failure                                                                                            |
| 6    | Rate limited (429)                                                                                         |

A `404` means _either_ the label does not exist _or_ you do not own it — Freelo collapses the two deliberately, so the CLI reports a plain "not found" and puts the ownership nuance in `hint_next`. It is **never** treated as an already-merged success: reporting exit 0 for a merge that never touched your data is the one failure this command must not have.

Note that `freelo task-labels find` lists every label **visible** to you, which includes labels used in projects you were invited to but do not own. It is therefore a superset of what merge accepts — it can show you a label this command still rejects with 404.

## Required permissions

- You must **own** both the target label and every source label.
- You must be a **commander** in a project for that project's tasks to be relabeled. Access below commander is not an error; those tasks are silently skipped.

## See also

- [`freelo task-labels find`](./task-labels-find.md) — resolve label names to the uuids this command takes
- [`freelo task-labels create`](./task-labels-create.md) — where duplicate labels come from in the first place
- [`freelo task-labels colors`](./task-labels-colors.md) — the palette, and why two labels with the same name can be different labels
