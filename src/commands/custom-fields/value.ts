import { type Command } from 'commander';
import { type GetAppConfig } from '../../config/schema.js';
import { registerSet } from './value/set.js';
import { registerClear } from './value/clear.js';

/**
 * Register the `custom-fields value` subcommand tree (R42, spec 0055 — second
 * slice of Wave 7, first writeable surface for custom fields).
 *
 * Mirrors `tasks/project.ts`: parent has no `meta`, no action — just children.
 * Each leaf has its own `meta`, action, and envelope schema.
 *
 * Two leaves in this slice:
 *   - `freelo custom-fields value set`    — upsert (text/number via --value, enum via --enum).
 *   - `freelo custom-fields value clear`  — destructive; read-then-delete.
 */
export function registerValue(
  customFields: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const value = customFields
    .command('value')
    .description(
      'Set or clear a custom-field value on a task. `set` upserts text/number/enum values; `clear` removes the value (idempotent: returns success when nothing was set).',
    );

  registerSet(value, getConfig, env);
  registerClear(value, getConfig, env);
}
