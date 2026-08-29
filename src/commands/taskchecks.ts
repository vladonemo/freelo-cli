import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerEdit } from './taskchecks/edit.js';
import { registerDelete } from './taskchecks/delete.js';
import { registerFinish } from './taskchecks/finish.js';
import { registerReopen } from './taskchecks/reopen.js';

/**
 * Register the `taskchecks` subcommand tree on the root program (M03, spec 0066).
 *
 * Mirrors `src/commands/subtasks.ts`: the parent carries no `meta` (only leaves
 * do), and each leaf is registered by its own factory.
 *
 * The parent description carries the id-space split, because that is the one
 * thing a user must understand before running any of these four commands
 * (spec 0066 §3 / decision 2).
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const taskchecks = program
    .command('taskchecks')
    .description(
      'Manage simple (non-smart) checklist items — the lightweight `tasks_checks` rows `freelo subtasks add` falls back to when a tasklist cannot host smart subtasks. ' +
        'These commands accept ONLY a simple checklist item id; a smart subtask (one with its own task id) returns 404 here and is managed with `freelo tasks edit|delete|finish|reopen` instead. ' +
        "Run `freelo subtasks list --task <parent-id>` and read each item's `type` field to tell them apart: `taskcheck` = simple (use these commands), `subtask` = smart (use `freelo tasks`). " +
        'The CLI deliberately does not guess between the two id spaces — they are independent integer sequences, so falling back on a 404 could act on an unrelated task.',
    );

  registerEdit(taskchecks, getConfig, env);
  registerDelete(taskchecks, getConfig, env);
  registerFinish(taskchecks, getConfig, env);
  registerReopen(taskchecks, getConfig, env);
}
