import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerList } from './comments/list.js';
import { registerAdd } from './comments/add.js';

/**
 * Register the `comments` subcommand tree on the root program (R16, R17).
 *
 * Mirrors `src/commands/subtasks.ts` shape: the parent carries no `meta`
 * (only leaves do), and each leaf is registered by its own factory. Future
 * slices (R18 `comments edit`/`comments delete`) extend the same group.
 *
 * Spec 0027 §3.1, spec 0028 §3.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const comments = program
    .command('comments')
    .description('Browse and post comments across projects, tasks, documents, files and links.');

  registerList(comments, getConfig, env);
  registerAdd(comments, getConfig, env);
}
