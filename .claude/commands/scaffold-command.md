---
description: Scaffold a new CLI subcommand from a template — file, test, MSW handlers, and doc page. Use after Phase 2 (Plan) to accelerate Phase 3.
argument-hint: <command-name> [--subcommand <name>]
---

You scaffold a new subcommand in the Freelo CLI. This is a helper, not an SDLC phase — it assumes a spec + plan already exist.

Argument: $ARGUMENTS

## What to do

1. Parse the command name. Reject if it already exists under `src/commands/`.
2. Create files using the project's established patterns (read an existing neighboring command file as the reference):
   - `src/commands/<name>.ts` — registers the command with a `register(program)` export, wires to `src/api/<name>.ts`, inherits global `--output auto|human|json|ndjson`, declares its output envelope schema `freelo.<name>.<op>/v1`
   - `src/api/<name>.ts` — typed endpoint function(s) with zod schemas in `src/api/schemas/<name>.ts`; returns `{ data, rateLimit, requestId }`
   - If it's a write command, wire `--dry-run`, batch input (`--id` / `--ids` / `--stdin`), and idempotent no-op handling; destructive ops must check `--yes` / TTY or throw `ConfirmationError`
   - `test/commands/<name>.test.ts` — integration test skeleton with MSW handlers for 200 and one error case; asserts the JSON envelope shape on non-TTY and the structured error envelope on failure
   - `test/fixtures/<name>.json` — placeholder fixture
   - `docs/commands/<name>.md` — doc page stub matching the `doc-writer` template
3. Register the new command in `src/bin/freelo.ts`.
4. Run `pnpm typecheck` to confirm wiring. Report any failures.
5. Remind the user that the scaffolds are empty — `/implement` is the next step.

## Do not

- Invent API behavior. The scaffolded endpoint function should have a `// TODO(<spec-path>):` comment, not a guessed implementation.
- Add a changeset yet — that's the implementer's job once the feature is real.
