import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerCreate } from './task-labels/create.js';
import { registerAttach } from './task-labels/attach.js';
import { registerDetach } from './task-labels/detach.js';
import { registerFind } from './task-labels/find.js';
import { registerColors } from './task-labels/colors.js';
import { registerMerge } from './task-labels/merge.js';

/**
 * Register the `task-labels` subcommand tree on the root program (R24,
 * spec 0036; `find` added by M04, spec 0062; `colors` added by M05,
 * spec 0067; `merge` added by M06, spec 0068).
 *
 * Mirrors `src/commands/labels.ts` shape: parent has a description but no
 * `meta` (only leaves do).
 *
 * Six leaves: `create`, `attach`, `detach`, `find`, `colors`, `merge`. `find`
 * and `colors` are the read-only ones; `merge` is the only destructive one and
 * the only leaf carrying a confirmation gate.
 *
 * `colors` is the odd one out in wiring terms: it maps to the top-level
 * `GET /task-label-colors` path, not to anything under `/task-labels`. It
 * lives here because it is about task-label colors from a user's point of
 * view. Spec 0067 §3.
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
  registerColors(taskLabels, getConfig, env);
  registerMerge(taskLabels, getConfig, env);
}
