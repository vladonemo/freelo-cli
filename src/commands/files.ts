import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerUpload } from './files/upload.js';

/**
 * Register the `files` subcommand tree on the root program (R25, spec 0037).
 *
 * Mirrors `src/commands/labels.ts` shape: the parent carries description
 * but no `meta` (only leaves do), and each leaf is registered by its own
 * factory.
 *
 * v1 has one leaf — `upload`. R26 (`list`) and R27 (`download`) extend the
 * group later.
 *
 * Spec 0037 §3.1.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const files = program
    .command('files')
    .description('Upload, list, and download project files. v1: upload only (R25).');

  registerUpload(files, getConfig, env);
}
