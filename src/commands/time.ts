import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerStart } from './time/start.js';
import { registerStatus } from './time/status.js';

/**
 * Register the `time` subcommand tree on the root program (R19, spec 0030).
 *
 * Mirrors `src/commands/comments.ts` shape: the parent carries no `meta`
 * (only leaves do). R20 (`time stop`, `time edit`) and R21+ (work-report
 * commands) will compose siblings here.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const time = program
    .command('time')
    .description('Time-tracking commands: start a timer, check status (R19); stop/edit (R20).');

  registerStart(time, getConfig, env);
  registerStatus(time, getConfig, env);
}
