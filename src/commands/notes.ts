import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerCreate } from './notes/create.js';
import { registerShow } from './notes/show.js';
import { registerEdit } from './notes/edit.js';
import { registerDelete } from './notes/delete.js';

/**
 * Register the `notes` subcommand tree on the root program (R44, spec 0058).
 *
 * Mirrors `src/commands/comments.ts` shape: the parent carries no `meta`
 * (only leaves do), and each leaf is registered by its own factory.
 *
 * Four leaves:
 *   - `notes create --project <id> --name <str> [--content ...]` — create a project note.
 *   - `notes show <id>`   — fetch a single note (full detail).
 *   - `notes edit <id>`   — overwrite name and/or content.
 *   - `notes delete <id>...` — soft-delete (destructive, batch).
 *
 * **Note:** `notes list` is intentionally not registered — Freelo's
 * documented API has no project-scoped notes/documents listing endpoint.
 * Reserved for R45+ when an endpoint becomes available. See spec 0058 §5.
 */
export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const notes = program
    .command('notes')
    .description('Create, show, edit, and delete project-level notes (rich-text blocks).');

  registerCreate(notes, getConfig, env);
  registerShow(notes, getConfig, env);
  registerEdit(notes, getConfig, env);
  registerDelete(notes, getConfig, env);
}
