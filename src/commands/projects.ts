import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerList } from './projects/list.js';

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
}
