import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerList } from './labels/list.js';
import { registerRename } from './labels/rename.js';
import { registerDelete } from './labels/delete.js';
import { registerAttach } from './labels/attach.js';
import { registerDetach } from './labels/detach.js';

/**
 * Register the `labels` subcommand tree on the root program (R23, spec 0035).
 *
 * Mirrors `src/commands/reports.ts` and `src/commands/time.ts` shape: the
 * parent carries no `meta` (only leaves do), and each leaf is registered by
 * its own factory.
 *
 * Five leaves: `list`, `rename`, `delete`, `attach`, `detach`.
 *
 * Spec 0035 §3.1.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const labels = program
    .command('labels')
    .description('Manage project labels — list, rename, delete, attach to projects, detach.');

  registerList(labels, getConfig, env);
  registerRename(labels, getConfig, env);
  registerDelete(labels, getConfig, env);
  registerAttach(labels, getConfig, env);
  registerDetach(labels, getConfig, env);
}
