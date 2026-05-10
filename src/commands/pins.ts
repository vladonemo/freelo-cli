import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerList } from './pins/list.js';
import { registerAdd } from './pins/add.js';
import { registerRemove } from './pins/remove.js';

/**
 * Register the `pins` subcommand tree on the root program (R44, spec 0058).
 *
 * Mirrors `src/commands/notes.ts` shape: parent has no `meta`, leaves do.
 *
 * Three leaves:
 *   - `pins list   --project <id>`            — list all pins on a project (read-only).
 *   - `pins add    --project <id> --link <url> [--title <str>]` — pin a URL.
 *   - `pins remove <id>...`                   — remove pins (destructive, batch).
 *
 * The `add` endpoint is a server-side dispatcher: internal-resource URLs
 * are fetch-or-create idempotent; external URLs always create.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const pins = program
    .command('pins')
    .description('List, add, and remove pinned items on projects.');

  registerList(pins, getConfig, env);
  registerAdd(pins, getConfig, env);
  registerRemove(pins, getConfig, env);
}
