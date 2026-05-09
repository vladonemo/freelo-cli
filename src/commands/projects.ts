import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerList } from './projects/list.js';
import { registerShow } from './projects/show.js';
import { registerCreate } from './projects/create.js';
import { registerCreateFromTemplate } from './projects/create-from-template.js';
import { registerArchive } from './projects/archive.js';
import { registerActivate } from './projects/activate.js';
import { registerDelete } from './projects/delete.js';
import { registerWorkers } from './projects/workers.js';

/**
 * Register the `projects` subcommand tree on the root program. Mirrors the
 * shape of `src/commands/auth.ts` and `src/commands/config.ts`: the parent
 * carries no `meta` (only leaves do), and each leaf is registered by its own
 * factory function.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const projects = program.command('projects').description('Browse and manage Freelo projects.');

  registerList(projects, getConfig, env);
  registerShow(projects, getConfig, env);
  registerCreate(projects, getConfig, env);
  registerCreateFromTemplate(projects, getConfig, env);
  registerArchive(projects, getConfig, env);
  registerActivate(projects, getConfig, env);
  registerDelete(projects, getConfig, env);
  registerWorkers(projects, getConfig, env);
}
