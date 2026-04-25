import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerList } from './config/list.js';
import { registerGet } from './config/get.js';
import { registerSet } from './config/set.js';
import { registerUnset } from './config/unset.js';
import { registerProfiles } from './config/profiles.js';
import { registerUse } from './config/use.js';
import { registerResolve } from './config/resolve.js';

/**
 * Register the `config` subcommand tree on the root program.
 * Each child command is a thin coordinator: parses args, calls config
 * operations, renders the result. No HTTP calls in this tree.
 *
 * `getConfig` is a lazy accessor that returns the fully-resolved
 * `PartialAppConfig`. It must only be called from within action handlers
 * (after Commander's `preAction` hook has fired).
 *
 * `env` is built exactly once in `src/bin/freelo.ts` and passed here so
 * commands never read process.env directly.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const config = program
    .command('config')
    .description('Manage freelo-cli configuration settings and profiles.');

  registerList(config, getConfig, env);
  registerGet(config, getConfig, env);
  registerSet(config, getConfig);
  registerUnset(config, getConfig);
  registerProfiles(config, getConfig);
  registerUse(config, getConfig);
  registerResolve(config, getConfig, env);
}
