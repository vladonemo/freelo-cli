import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerList } from './comments/list.js';

/**
 * Register the `comments` subcommand tree on the root program (R16).
 *
 * Mirrors `src/commands/subtasks.ts` shape: the parent carries no `meta`
 * (only leaves do), and each leaf is registered by its own factory. Future
 * slices (R17 `comments add`, R18 `comments edit`/`comments delete`) extend
 * the same group.
 *
 * Spec 0027 §3.1.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const comments = program
    .command('comments')
    .description('Browse comments across all projects, tasks, documents, files and links.');

  registerList(comments, getConfig, env);
}
