import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerList } from './reports/list.js';
import { registerLog } from './reports/log.js';
import { registerEdit } from './reports/edit.js';
import { registerDelete } from './reports/delete.js';

/**
 * Register the `reports` subcommand tree on the root program (R21 list,
 * spec 0033; R22 writes, spec 0034).
 *
 * Mirrors `src/commands/comments.ts` and `src/commands/time.ts` shape: the
 * parent carries no `meta` (only leaves do), and each leaf is registered by
 * its own factory.
 *
 * R21 ships `registerList`. R22 adds `registerLog` / `registerEdit` /
 * `registerDelete`.
 *
 * Spec 0033 §3.1, spec 0034 §3.1.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const reports = program
    .command('reports')
    .description('Browse, log, amend, and remove work reports (time entries) across all projects.');

  registerList(reports, getConfig, env);
  registerLog(reports, getConfig, env);
  registerEdit(reports, getConfig, env);
  registerDelete(reports, getConfig, env);
}
