import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerTypes } from './custom-fields/types.js';
import { registerList } from './custom-fields/list.js';

/**
 * Register the `custom-fields` subcommand tree on the root program (R40,
 * spec 0054 — first slice of Wave 7).
 *
 * Mirrors `tasks/project.ts`: parent has no `meta`, no action — just children.
 * Each leaf has its own `meta`, action, and envelope schema.
 *
 * Two read-only leaves in this slice:
 *   - `freelo custom-fields types`           — list the type catalog.
 *   - `freelo custom-fields list --project`  — list fields configured on a project.
 *
 * Wave 7 will keep adding leaves here:
 *   - R41 — create / rename / delete / restore.
 *   - R42 — value set / value clear.
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
      'Inspect Freelo custom-field type definitions and the custom fields configured on a project. Read-only — write commands (create / rename / delete / restore / value set) land in later Wave 7 slices.',
    );

  registerTypes(customFields, getConfig, env);
  registerList(customFields, getConfig, env);
}
