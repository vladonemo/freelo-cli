import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerStart } from './time/start.js';
import { registerStatus } from './time/status.js';
import { registerStop } from './time/stop.js';
import { registerEdit } from './time/edit.js';

/**
 * Register the `time` subcommand tree on the root program (R19 spec 0030 +
 * R20 spec 0032).
 *
 * Mirrors `src/commands/comments.ts` shape: the parent carries no `meta`
 * (only leaves do). Subcommand registration order is the same as the
 * documented sequence (start → stop → edit → status), which is also the
 * order they appear in `freelo time --help`.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const time = program
    .command('time')
    .description(
      'Time-tracking commands: start, stop, edit, and check status of the active timer.',
    );

  registerStart(time, getConfig, env);
  registerStop(time, getConfig, env);
  registerEdit(time, getConfig, env);
  registerStatus(time, getConfig, env);
}
