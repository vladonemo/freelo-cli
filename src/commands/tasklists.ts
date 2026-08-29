import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerList } from './tasklists/list.js';
import { registerShow } from './tasklists/show.js';
import { registerCreate } from './tasklists/create.js';
import { registerCreateFromTemplate } from './tasklists/create-from-template.js';
import { registerEdit } from './tasklists/edit.js';

/**
 * Register the `tasklists` subcommand tree on the root program. Mirrors the
 * shape of `src/commands/projects.ts`: the parent carries no `meta` (only
 * leaves do), and each leaf is registered by its own factory function.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const tasklists = program
    .command('tasklists')
    .description('Browse and manage Freelo tasklists across the projects you can see.');

  registerList(tasklists, getConfig, env);
  registerShow(tasklists, getConfig, env);
  registerCreate(tasklists, getConfig, env);
  registerCreateFromTemplate(tasklists, getConfig, env);
  registerEdit(tasklists, getConfig, env);
}
