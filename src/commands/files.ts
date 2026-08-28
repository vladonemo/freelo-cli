import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerUpload } from './files/upload.js';
import { registerList } from './files/list.js';
import { registerDownload } from './files/download.js';
import { registerDelete } from './files/delete.js';

/**
 * Register the `files` subcommand tree on the root program (R25 + R26 + R27 +
 * M07).
 *
 * Mirrors `src/commands/labels.ts` shape: the parent carries description
 * but no `meta` (only leaves do), and each leaf is registered by its own
 * factory.
 *
 * Leaves: `upload` (R25, spec 0037), `list` (R26, spec 0038), `download`
 * (R27, spec 0039), `delete` (M07, spec 0064).
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const files = program
    .command('files')
    .description(
      'Upload, list, download, and delete project files and documents. v1: upload + list + download + delete (R25, R26, R27, M07).',
    );

  registerUpload(files, getConfig, env);
  registerList(files, getConfig, env);
  registerDownload(files, getConfig, env);
  registerDelete(files, getConfig, env);
}
