import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerList } from './tasks/list.js';
import { registerShow } from './tasks/show.js';
import { registerCreate } from './tasks/create.js';
import { registerEdit } from './tasks/edit.js';
import { registerFinish } from './tasks/finish.js';
import { registerReopen } from './tasks/reopen.js';
import { registerMove } from './tasks/move.js';
import { registerDelete } from './tasks/delete.js';
import { registerDescription } from './tasks/description.js';
import { registerRemind } from './tasks/remind.js';
import { registerShare } from './tasks/share.js';
import { registerUnshare } from './tasks/unshare.js';
import { registerEstimate } from './tasks/estimate.js';

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
    .description(
      'Browse, create, and edit Freelo tasks across the projects and tasklists you can see.',
    );

  registerList(tasks, getConfig, env);
  registerShow(tasks, getConfig, env);
  registerCreate(tasks, getConfig, env);
  registerEdit(tasks, getConfig, env);
  registerFinish(tasks, getConfig, env);
  registerReopen(tasks, getConfig, env);
  registerMove(tasks, getConfig, env);
  registerDelete(tasks, getConfig, env);
  registerDescription(tasks, getConfig, env);
  registerRemind(tasks, getConfig, env);
  registerShare(tasks, getConfig, env);
  registerUnshare(tasks, getConfig, env);
  registerEstimate(tasks, getConfig, env);
}
