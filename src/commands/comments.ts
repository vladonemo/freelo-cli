import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerList } from './comments/list.js';
import { registerAdd } from './comments/add.js';
import { registerEdit } from './comments/edit.js';

/**
 * Register the `comments` subcommand tree on the root program (R16, R17, R18).
 *
 * Mirrors `src/commands/subtasks.ts` shape: the parent carries no `meta`
 * (only leaves do), and each leaf is registered by its own factory. R18.5
 * (`comments delete`) is queued — endpoint not in `docs/api/freelo-api.yaml`
 * as of 2026-04-28; awaiting `freelo-api-specialist` confirmation.
 *
 * Spec 0027 §3.1, spec 0028 §3, spec 0029 §3.
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
  registerEdit(comments, getConfig, env);
}
