---
name: cli-design
description: UX and ergonomics patterns for the Freelo CLI — subcommand shape, flag naming, output modes, prompts, exit codes. Load when designing or reviewing a command's surface.
---

# CLI Design — patterns and principles

Benchmarks for "feels professional": `gh`, `stripe`, `vercel`, `aws`, `flyctl`. When in doubt, look at how one of these handles the same problem.

## Command shape

- `freelo <noun> <verb>` — noun first, then action. (`tasks list`, not `list-tasks`.)
- Verbs: `list`, `get`, `create`, `update`, `delete`, `complete`, `assign`, `comment`.
- Avoid cute aliases. One name per command, discoverable via `freelo --help`.
- Hierarchy max two levels deep: `freelo <noun> <verb>`. No `freelo projects members roles grant` — flatten or split.

## Flags

- **Always provide long form** (`--project`). Short form only when it's obvious and high-frequency (`-o` for output).
- Boolean flags default to off. If you find yourself wanting `--no-foo`, reconsider the default.
- Flag names use `kebab-case`: `--tasklist-id`, not `--tasklistId`.
- Avoid single-letter flags that conflict with well-known ones (`-h` is help, `-v` is often verbose — don't reuse for `--version`).

## Inputs

- Positional arg for the primary object ID when unambiguous: `freelo tasks get 1234`.
- Otherwise a required flag: `freelo tasks create --tasklist 7 --name "..."`.
- Accept IDs from stdin when `-` is given: `echo 1234 | freelo tasks get -`.
- Accept JSON via `--data @file.json` or `--data -` for scriptable creates.

## Output

Three modes, one flag:

- `--output table` (default for lists)
- `--output json` (machine-readable, newline-terminated)
- `--output yaml` (for humans reading structured data)

For single-object output, `table` falls back to a pretty key/value layout.

- **Primary output to stdout. Logs and errors to stderr.** Always.
- Never mix a spinner and output on the same stream.
- Exit 0 only on success. A list returning zero items is still success.

## Interactivity

- Prompt only when `process.stdout.isTTY` **and** `--yes`/`-y` is not set.
- Destructive actions (`delete`, `archive`) require confirmation unless `--yes`.
- Prompts use `@inquirer/prompts`. Offer a default the user can Enter through.

## Feedback

- Long operations (>300ms perceived) get a spinner with action-oriented text: "Fetching tasks…"
- On completion, print a one-line status: `✓ 42 tasks fetched` (TTY only).
- On failure, stop the spinner, print the error to stderr, set the exit code.

## Errors

Messages are **for humans**:

- State what happened: "Could not fetch project 42."
- Why if known: "the API returned 403 Forbidden."
- What to do: "Check that your token has access to this project, or run `freelo auth status`."

No stack traces unless `FREELO_DEBUG=1`.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Generic failure (last resort) |
| 2 | Usage / arg validation error |
| 3 | Auth error — missing or expired token |
| 4 | API error — Freelo returned 4xx/5xx |
| 5 | Network error |
| 130 | SIGINT |

## Help text

- First line: one-sentence summary, ends with a period.
- Usage block: flag order matches the options list.
- Examples: at least two — one minimal, one realistic.
- Keep it under a screenful. Detail belongs in `docs/commands/<cmd>.md`.

## Anti-patterns (don't)

- Ask interactive questions when there's no TTY (scripts will hang).
- Print colored output when `NO_COLOR` is set or `!isTTY`.
- Use emoji in default output. (Allowed in `chalk.symbols` style ASCII ticks: `✓` `✗`.)
- Invent new output formats. Three modes is enough.
- Print a hundred rows without paginating the API call under the hood.
