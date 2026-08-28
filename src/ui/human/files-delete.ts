import { type FilesDeleteData } from '../../api/schemas/file.js';

/**
 * Human renderer for `freelo files delete` (M07, spec 0064).
 *
 * Two shapes, gated on `data.would`:
 *   - Live success:    `Deleted file or document <uuid>.`
 *   - Dry-run (would): `(dry-run) Would delete file or document <uuid>.`
 *
 * The phrase "file or document" is deliberate, and deliberately a little
 * awkward. `DELETE /file/{file_uuid}` resolves the resource kind server-side
 * and its 200 body carries no discriminator (yaml :4497, :4514-4519), so the
 * CLI genuinely does not know which of the two it just removed. `Deleted file
 * <uuid>.` would be a plain untruth every time the UUID pointed at a note.
 * Spec 0064 §6.2.
 *
 * There is deliberately **no** "was already deleted" shape. Unlike
 * `tasks delete` (R13), this command never absorbs a 404 into an idempotent
 * success, so `already_in_target_state` is unreachable-true in v1 (spec 0064
 * §5.1 / decision 3). A third branch here would be dead code and a permanent
 * coverage hole (calibration §4).
 */
export function renderFilesDeleteHuman(data: FilesDeleteData): string {
  if (data.would !== undefined) {
    return `(dry-run) Would delete file or document ${data.uuid}.`;
  }
  return `Deleted file or document ${data.uuid}.`;
}
