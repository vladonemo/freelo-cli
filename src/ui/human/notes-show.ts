import { type NotesShowData } from '../../api/schemas/note.js';

/**
 * Human-mode renderer for `freelo notes show` (R44, spec 0058).
 *
 * Renders a brief multi-line summary:
 *
 *   Note #<id>: "<name>"
 *     Project: <project name or id>
 *     Author:  <fullname or id>
 *     Created: <date_add>
 *     Edited:  <date_edited_at>
 *     Content: <N> bytes
 */
export function renderNotesShowHuman(data: NotesShowData): string {
  const note = data.note;
  const lines: string[] = [];
  const idPart = note.id !== undefined && note.id !== null ? `#${note.id}` : '#?';
  const namePart =
    note.name !== undefined && note.name !== null ? `: ${JSON.stringify(note.name)}` : '';
  lines.push(`Note ${idPart}${namePart}`);

  const projectLabel = formatProject(note.project);
  if (projectLabel !== null) lines.push(`  Project: ${projectLabel}`);

  const authorLabel = formatAuthor(note.author);
  if (authorLabel !== null) lines.push(`  Author:  ${authorLabel}`);

  if (note.date_add !== undefined && note.date_add !== null) {
    lines.push(`  Created: ${note.date_add}`);
  }
  if (note.date_edited_at !== undefined && note.date_edited_at !== null) {
    lines.push(`  Edited:  ${note.date_edited_at}`);
  }

  const contentLength =
    note.content !== undefined && note.content !== null
      ? Buffer.byteLength(note.content, 'utf8')
      : 0;
  lines.push(`  Content: ${contentLength} bytes`);

  return lines.join('\n');
}

function formatProject(p: NotesShowData['note']['project']): string | null {
  if (p === undefined || p === null) return null;
  if (p.name !== undefined && p.name !== null) return `${p.name} (#${p.id})`;
  return `#${p.id}`;
}

function formatAuthor(a: NotesShowData['note']['author']): string | null {
  if (a === undefined || a === null) return null;
  if (a.fullname !== undefined && a.fullname !== null) return `${a.fullname} (#${a.id})`;
  return `#${a.id}`;
}
