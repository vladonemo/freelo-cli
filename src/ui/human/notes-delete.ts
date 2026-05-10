import { type NotesDeleteData } from '../../api/schemas/note.js';

/**
 * Human-mode renderer for `freelo notes delete` (R44, spec 0058).
 *
 * Live:                `Deleted note #<id>.`
 * Idempotent skip:     `Already deleted: note #<id>.`
 * Dry-run:             `(dry-run) Would DELETE note #<id>.`
 */
export function renderNotesDeleteHuman(data: NotesDeleteData): string {
  if (data.would !== undefined) {
    return `(dry-run) Would DELETE note #${data.note_id}.`;
  }
  if (data.already_in_target_state) {
    return `Already deleted: note #${data.note_id}.`;
  }
  return `Deleted note #${data.note_id}.`;
}
