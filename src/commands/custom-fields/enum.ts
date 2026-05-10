import { type Command } from 'commander';
import { type GetAppConfig } from '../../config/schema.js';
import { registerEnumList } from './enum/list.js';
import { registerEnumAdd } from './enum/add.js';
import { registerEnumRename } from './enum/rename.js';
import { registerEnumDelete } from './enum/delete.js';

/**
 * Register the `custom-fields enum` subcommand tree (R43, spec 0057 — third
 * slice of Wave 7, enum-option management on enum-typed custom fields).
 *
 * Mirrors `tasks/project.ts` / `custom-fields/value.ts`: parent has no `meta`,
 * no action — just children. Each leaf has its own `meta`, action, and
 * envelope schema.
 *
 * Four leaves in this slice:
 *   - `freelo custom-fields enum list`    — read-only.
 *   - `freelo custom-fields enum add`     — single-shot upsert of an option.
 *   - `freelo custom-fields enum rename`  — single-shot rename.
 *   - `freelo custom-fields enum delete`  — destructive; --force selects the
 *     cascading endpoint (clears referencing task values).
 */
export function registerEnum(
  customFields: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const enumCmd = customFields
    .command('enum')
    .description(
      'Manage enum options on enum-typed custom fields. Read with `list`; mutate with `add` / `rename` / `delete`. `delete --force` cascades to referencing task values.',
    );

  registerEnumList(enumCmd, getConfig, env);
  registerEnumAdd(enumCmd, getConfig, env);
  registerEnumRename(enumCmd, getConfig, env);
  registerEnumDelete(enumCmd, getConfig, env);
}
