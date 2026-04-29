import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerList } from './reports/list.js';

/**
 * Register the `reports` subcommand tree on the root program (R21, spec 0033).
 *
 * Mirrors `src/commands/comments.ts` and `src/commands/time.ts` shape: the
 * parent carries no `meta` (only leaves do), and each leaf is registered by
 * its own factory. R21 only ships `registerList`; R22 will add
 * `registerLog` / `registerEdit` / `registerDelete`.
 *
 * Spec 0033 §3.1.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const reports = program
    .command('reports')
    .description(
      'Browse work reports (time entries) across all projects with task / project / worker / date filters.',
    );

  registerList(reports, getConfig, env);
}
