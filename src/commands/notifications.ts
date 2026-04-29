import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerList } from './notifications/list.js';
import { registerRead } from './notifications/read.js';
import { registerUnread } from './notifications/unread.js';

/**
 * Register the `notifications` subcommand tree on the root program (R28,
 * spec 0040).
 *
 * Mirrors `src/commands/files.ts` shape: parent has a description but no
 * `meta` (only leaves do).
 *
 * Three leaves: `list`, `read`, `unread`.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const notifications = program
    .command('notifications')
    .description(
      'List notifications addressed to the calling user, mark them as read, or mark them as unread. R28: list / read / unread.',
    );

  registerList(notifications, getConfig, env);
  registerRead(notifications, getConfig, env);
  registerUnread(notifications, getConfig, env);
}
