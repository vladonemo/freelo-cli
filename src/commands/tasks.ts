import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerList } from './tasks/list.js';

/**
 * Register the `tasks` subcommand tree on the root program. Mirrors the
 * shape of `src/commands/tasklists.ts`: the parent carries no `meta`
 * (only leaves do), and each leaf is registered by its own factory.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const tasks = program
    .command('tasks')
    .description('Browse Freelo tasks across the projects and tasklists you can see.');

  registerList(tasks, getConfig, env);
}
