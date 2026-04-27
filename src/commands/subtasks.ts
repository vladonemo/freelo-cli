import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerList } from './subtasks/list.js';
import { registerAdd } from './subtasks/add.js';

/**
 * Register the `subtasks` subcommand tree on the root program (R14).
 *
 * Mirrors `src/commands/tasks.ts` shape: the parent carries no `meta`
 * (only leaves do), and each leaf is registered by its own factory.
 *
 * Spec 0025 §3.1.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const subtasks = program
    .command('subtasks')
    .description(
      'Inspect and add subtasks (taskchecks) under a parent task. Read- and add-only in v1.',
    );

  registerList(subtasks, getConfig, env);
  registerAdd(subtasks, getConfig, env);
}
