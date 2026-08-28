import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerList } from './comments/list.js';
import { registerAdd } from './comments/add.js';
import { registerEdit } from './comments/edit.js';
import { registerDelete } from './comments/delete.js';

/**
 * Register the `comments` subcommand tree on the root program (R16, R17, R18,
 * M01).
 *
 * Mirrors `src/commands/subtasks.ts` shape: the parent carries no `meta`
 * (only leaves do), and each leaf is registered by its own factory.
 *
 * `comments delete` (M01, spec 0061) closes out the long-queued R18.5: the
 * endpoint was absent from `docs/api/freelo-api.yaml` as of 2026-04-28 and
 * arrived in the 2026-08-24 refresh as `DELETE /comment/{comment_id}`.
 *
 * Spec 0027 §3.1, spec 0028 §3, spec 0029 §3, spec 0061 §2.
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
  registerDelete(comments, getConfig, env);
}
