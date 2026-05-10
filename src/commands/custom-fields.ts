import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerTypes } from './custom-fields/types.js';
import { registerList } from './custom-fields/list.js';
import { registerCreate } from './custom-fields/create.js';
import { registerRename } from './custom-fields/rename.js';
import { registerDelete } from './custom-fields/delete.js';
import { registerRestore } from './custom-fields/restore.js';
import { registerValue } from './custom-fields/value.js';

/**
 * Register the `custom-fields` subcommand tree on the root program.
 *
 * Mirrors `tasks/project.ts`: parent has no `meta`, no action — just children.
 * Each leaf has its own `meta`, action, and envelope schema.
 *
 * Six leaves currently:
 *   - R40 (spec 0054):
 *     - `freelo custom-fields types`           — list the type catalog (read-only).
 *     - `freelo custom-fields list --project`  — list fields configured on a project (read-only).
 *   - R41 (spec 0055):
 *     - `freelo custom-fields create --project --name --type` — create a custom field.
 *     - `freelo custom-fields rename <uuid> --name`           — rename.
 *     - `freelo custom-fields delete <uuid>...`               — soft-delete (destructive).
 *     - `freelo custom-fields restore <uuid>...`              — restore a soft-deleted field.
 *
 * Wave 7 will keep adding leaves here:
 *   - R42 — value set / value clear (this slice adds the `value` parent).
 *   - R43 — enum {list, add, rename, delete}.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const customFields = program
    .command('custom-fields')
    .description(
      'Inspect and manage Freelo custom-field type definitions and the custom fields configured on a project. Read commands (`types`, `list`) plus CRUD (`create`, `rename`, `delete`, `restore`).',
    );

  registerTypes(customFields, getConfig, env);
  registerList(customFields, getConfig, env);
  registerCreate(customFields, getConfig, env);
  registerRename(customFields, getConfig, env);
  registerDelete(customFields, getConfig, env);
  registerRestore(customFields, getConfig, env);
  registerValue(customFields, getConfig, env);
}
