import { type Command } from 'commander';
import { type GetAppConfig } from '../../config/schema.js';
import { registerRemindSet } from './remind/set.js';
import { registerRemindClear } from './remind/clear.js';

/**
 * Register the `tasks remind` parent subcommand on `tasks` (R35, spec 0049).
 *
 * Mirrors the shape of `src/commands/tasks/description.ts`: parent carries
 * no `meta` and no action — just children. Each leaf has its own `meta`,
 * its own action, its own envelope schema.
 */
export function registerRemind(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const remind = tasks
    .command('remind')
    .description(
      'Manage your personal reminder on a task. Reminders are per-user — they only ping you, not other workers on the task.',
    );

  registerRemindSet(remind, getConfig, env);
  registerRemindClear(remind, getConfig, env);
}
