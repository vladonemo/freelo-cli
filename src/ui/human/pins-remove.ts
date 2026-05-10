import { type PinsRemoveData } from '../../api/schemas/pin.js';

/**
 * Human-mode renderer for `freelo pins remove` (R44, spec 0058).
 *
 * Live:                `Removed pinned item #<id>.`
 * Idempotent skip:     `Already removed: pinned item #<id>.`
 * Dry-run:             `(dry-run) Would DELETE pinned item #<id>.`
 */
export function renderPinsRemoveHuman(data: PinsRemoveData): string {
  if (data.would !== undefined) {
    return `(dry-run) Would DELETE pinned item #${data.pin_id}.`;
  }
  if (data.already_in_target_state) {
    return `Already removed: pinned item #${data.pin_id}.`;
  }
  return `Removed pinned item #${data.pin_id}.`;
}
