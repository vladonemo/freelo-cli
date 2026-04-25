import { type Command } from 'commander';
import { type PartialAppConfig } from '../config/schema.js';
import { registerLogin } from './auth/login.js';
import { registerLogout } from './auth/logout.js';
import { registerWhoami } from './auth/whoami.js';

/**
 * Register the `auth` subcommand tree on the root program.
 * Each child command is a thin coordinator: parses args, calls an API
 * function or config operation, renders the result.
 *
 * `appConfig` and `env` are built exactly once in `src/bin/freelo.ts` and
 * passed here so commands never read process.env directly.
 */
export function register(
  program: Command,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const auth = program.command('auth').description('Manage Freelo authentication credentials.');

  registerLogin(auth, appConfig, env);
  registerLogout(auth, appConfig);
  registerWhoami(auth, appConfig, env);
}
