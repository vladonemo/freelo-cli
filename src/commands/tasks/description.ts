import { type Command } from 'commander';
import { type GetAppConfig } from '../../config/schema.js';
import { registerDescriptionGet } from './description/get.js';
import { registerDescriptionSet } from './description/set.js';

/**
 * Register the `tasks description` parent subcommand on `tasks` (R15).
 *
 * Mirrors the shape of `src/commands/subtasks.ts`: the parent carries no
 * `meta` (only leaves do), no action — just children.
 *
 * Spec 0026 §3.1.
 */
export function registerDescription(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const description = tasks
    .command('description')
    .description("Read or replace a task's rich-text description (upsert).");

  registerDescriptionGet(description, getConfig, env);
  registerDescriptionSet(description, getConfig, env);
}
