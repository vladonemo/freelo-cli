import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerCreate } from './task-labels/create.js';
import { registerAttach } from './task-labels/attach.js';
import { registerDetach } from './task-labels/detach.js';
import { registerFind } from './task-labels/find.js';

/**
 * Register the `task-labels` subcommand tree on the root program (R24,
 * spec 0036; `find` added by M04, spec 0062).
 *
 * Mirrors `src/commands/labels.ts` shape: parent has a description but no
 * `meta` (only leaves do).
 *
 * Four leaves: `create`, `attach`, `detach`, `find`. `find` is the only
 * read-only one.
 *
 * NOTE: this is a sibling of `freelo labels` (project-labels, R23) but a
 * **separate Freelo concept**: task-labels are global label definitions
 * attached/detached to/from individual tasks. Different endpoints, different
 * resource shape.
 *
 * Spec 0036 §3.1.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const taskLabels = program
    .command('task-labels')
    .description(
      'Manage task-scoped labels — bulk-create label definitions, attach to tasks, detach from tasks. Sibling of `freelo labels` (project-labels) but a separate Freelo concept.',
    );

  registerCreate(taskLabels, getConfig, env);
  registerAttach(taskLabels, getConfig, env);
  registerDetach(taskLabels, getConfig, env);
  registerFind(taskLabels, getConfig, env);
}
