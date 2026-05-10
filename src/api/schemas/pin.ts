import { z } from 'zod';
import { type Would } from '../../lib/dry-run.js';

/**
 * Zod schemas for the `pinned-items` resource group, R44 (spec 0058).
 *
 * Wire shape: `PinnedItem` from OpenAPI :5072-5082 — a flat object with
 * `id`, `link`, `title`. All three are documented as optional on the
 * component schema; `id` is universally present in practice on returned
 * rows. `.passthrough()` so future API additions (e.g. internal-resource
 * metadata) don't break validation. Per spec 0058 decision 15.
 */
export const PinnedItemSchema = z
  .object({
    id: z.number().int(),
    link: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
  })
  .passthrough();

export type PinnedItem = z.infer<typeof PinnedItemSchema>;

/**
 * `GET /project/{id}/pinned-items` — flat array (yaml :1054 — "The
 * response is a flat array, not paginated.").
 */
export const PinnedItemsListResponseSchema = z.array(PinnedItemSchema);
export type PinnedItemsListResponse = z.infer<typeof PinnedItemsListResponseSchema>;

/* ---------------------------------------------------------------------------
 *  Envelope-data types
 *
 *  Per spec 0058 §2.3. All envelopes are additive; no existing schema is
 *  changed.
 * ------------------------------------------------------------------------- */

export type PinsListData = {
  project_id: number;
  pins: PinnedItem[];
};

export type PinsAddData = {
  project_id: number;
  /** Server-returned pin. Present on live success; absent in --dry-run. */
  pin?: PinnedItem;
  /** Echo of --link as the user passed it (server may dispatch internally). */
  applied_link: string;
  /** Echo of --title; omitted when the flag was not passed. */
  applied_title?: string;
  would?: Would;
};

export type PinsRemoveData = {
  pin_id: number;
  previous_state: null;
  current_state: 'removed';
  already_in_target_state: boolean;
  would?: Would;
  line_index?: number;
};
