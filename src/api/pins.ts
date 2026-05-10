import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import {
  PinnedItemSchema,
  PinnedItemsListResponseSchema,
  type PinnedItem,
  type PinnedItemsListResponse,
} from './schemas/pin.js';

/**
 * Wire wrappers for the `pinned-items` resource group, R44 (spec 0058).
 *
 * Endpoints (yaml :1040-1137):
 *   - `GET    /project/{project_id}/pinned-items`  — list (flat array)
 *   - `POST   /project/{project_id}/pinned-items`  — pin URL (server-side
 *                                                     dispatcher: internal
 *                                                     URLs are fetch-or-create
 *                                                     idempotent; external
 *                                                     URLs always create)
 *   - `DELETE /pinned-item/{pinned_item_id}`       — un-pin (returns
 *                                                     SuccessResponse)
 *
 * Every wrapper threads `signal` + `requestId` opt-spreads (calibration §4:
 * branch-coverage in the sibling `test/api/pins.test.ts`).
 */

export type PinsOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

/* ---------------------------------------------------------------------------
 *  Path helpers — exported for `--dry-run` envelopes.
 * ------------------------------------------------------------------------- */

/** Path for `GET /project/{project_id}/pinned-items` and `POST /project/{project_id}/pinned-items`. */
export function pinnedItemsPath(projectId: number): string {
  return `/project/${projectId}/pinned-items`;
}

/** Path for `DELETE /pinned-item/{pinned_item_id}`. */
export function pinnedItemPath(pinnedItemId: number): string {
  return `/pinned-item/${pinnedItemId}`;
}

/* ---------------------------------------------------------------------------
 *  Wire body shapes
 * ------------------------------------------------------------------------- */

/**
 * Wire-shape of the POST body for `/project/{project_id}/pinned-items`.
 * Per yaml :1085-1100, `link` is required; `title` is optional. **Note:**
 * the wire field is `link` (NOT `url`) — see spec 0058 decision 12.
 */
export type PinItemBody = {
  link: string;
  title?: string;
};

/* ---------------------------------------------------------------------------
 *  Result envelopes
 * ------------------------------------------------------------------------- */

export type GetPinnedItemsResult = {
  raw: ApiResponse<PinnedItemsListResponse>;
  body: PinnedItemsListResponse;
};

export type PinItemResult = {
  raw: ApiResponse<PinnedItem>;
  body: PinnedItem;
};

/**
 * Successful DELETE returns `SuccessResponse` (yaml :1131-1137 —
 * `{ result: 'success' }`). The CLI doesn't propagate any field other
 * than the schema-validated wrapper, so we use a permissive shape here.
 */
const DeletePinnedItemResponseSchema = z
  .object({ result: z.string().nullable().optional() })
  .passthrough();
type DeletePinnedItemResponse = z.infer<typeof DeletePinnedItemResponseSchema>;

export type DeletePinnedItemResult = {
  raw: ApiResponse<DeletePinnedItemResponse>;
  body: DeletePinnedItemResponse;
};

/* ---------------------------------------------------------------------------
 *  Wire calls
 * ------------------------------------------------------------------------- */

/**
 * `GET /project/{project_id}/pinned-items` — list all pinned items on a
 * project, ACL-filtered server-side. Spec 0058 §2.2.
 */
export async function getPinnedItems(
  client: HttpClient,
  projectId: number,
  opts: PinsOpts = {},
): Promise<GetPinnedItemsResult> {
  const raw = await client.request({
    method: 'GET',
    path: pinnedItemsPath(projectId),
    schema: PinnedItemsListResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/**
 * `POST /project/{project_id}/pinned-items` — pin a URL to the project.
 * Server-side dispatcher (yaml :1078-1080): internal-resource URLs are
 * fetch-or-create idempotent; external URLs always create. Spec 0058 §2.2.
 */
export async function pinItem(
  client: HttpClient,
  projectId: number,
  body: PinItemBody,
  opts: PinsOpts = {},
): Promise<PinItemResult> {
  const raw = await client.request({
    method: 'POST',
    path: pinnedItemsPath(projectId),
    body,
    schema: PinnedItemSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/**
 * `DELETE /pinned-item/{pinned_item_id}` — remove a pinned item. Spec
 * 0058 §2.2.
 */
export async function deletePinnedItem(
  client: HttpClient,
  pinnedItemId: number,
  opts: PinsOpts = {},
): Promise<DeletePinnedItemResult> {
  const raw = await client.request({
    method: 'DELETE',
    path: pinnedItemPath(pinnedItemId),
    schema: DeletePinnedItemResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/* ---------------------------------------------------------------------------
 *  Pure body builder
 * ------------------------------------------------------------------------- */

export type PinItemInput = {
  link: string;
  title?: string;
};

export function buildPinItemBody(input: PinItemInput): PinItemBody {
  if (input.title !== undefined) {
    return { link: input.link, title: input.title };
  }
  return { link: input.link };
}
