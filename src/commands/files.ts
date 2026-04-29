import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerUpload } from './files/upload.js';
import { registerList } from './files/list.js';
import { registerDownload } from './files/download.js';

/**
 * Register the `files` subcommand tree on the root program (R25 + R26 + R27).
 *
 * Mirrors `src/commands/labels.ts` shape: the parent carries description
 * but no `meta` (only leaves do), and each leaf is registered by its own
 * factory.
 *
 * Leaves: `upload` (R25, spec 0037), `list` (R26, spec 0038), `download`
 * (R27, spec 0039).
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const files = program
    .command('files')
    .description(
      'Upload, list, and download project files. v1: upload + list + download (R25, R26, R27).',
    );

  registerUpload(files, getConfig, env);
  registerList(files, getConfig, env);
  registerDownload(files, getConfig, env);
}
