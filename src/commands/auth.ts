import { type Command } from 'commander';
import { registerLogin } from './auth/login.js';
import { registerLogout } from './auth/logout.js';
import { registerWhoami } from './auth/whoami.js';

/**
 * Register the `auth` subcommand tree on the root program.
 * Each child command is a thin coordinator: parses args, calls an API
 * function or config operation, renders the result.
 */
export function register(program: Command): void {
  const auth = program.command('auth').description('Manage Freelo authentication credentials.');

  registerLogin(auth);
  registerLogout(auth);
  registerWhoami(auth);
}
