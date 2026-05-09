import { z } from 'zod';

/**
 * Zod schemas + envelope `data` types for R36 `freelo tasks share` /
 * `tasks unshare` (spec 0050). Two endpoints, two response shapes:
 *
 *   - `GET    /public-link/task/{task_id}` (yaml :2155-2165) → `ShareTaskResponse`
 *   - `DELETE /public-link/task/{task_id}` (yaml :2179-2185) → `SuccessResponse`
 *
 * Note on the verb: the roadmap shorthand says POST; the authoritative
 * OpenAPI documents this as a "GET that creates" — first call mints the
 * URL, subsequent calls return the same URL. See spec 0050 decision 1.
 *
 * Both schemas use `.passthrough()` per the project-wide convention (Freelo
 * extends success bodies occasionally without a contract bump).
 */

/**
 * `GET /public-link/task/{task_id}` response. The OpenAPI documents `url`
 * with `format: uri` but does not mark it `required:`. We treat it as
 * required-string-on-200 — Freelo's contract here is "200 carries the
 * URL or it isn't a 200". A schema-level absence triggers a
 * `FreeloApiError` (`VALIDATION_ERROR`, exit 4) at the client layer, not
 * a silent null.
 */
export const ShareTaskResponseSchema = z
  .object({
    url: z.string(),
  })
  .passthrough();

export type ShareTaskResponse = z.infer<typeof ShareTaskResponseSchema>;

/**
 * `DELETE /public-link/task/{task_id}` response — generic `SuccessResponse`,
 * mirrors the R35 `clear` schema. Tolerates additional fields via
 * `.passthrough()`.
 */
export const UnshareTaskResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

/* ---------------------------------------------------------------------------
 *  Envelope `data` types (consumed by `src/commands/tasks/{share,unshare}.ts`).
 * ------------------------------------------------------------------------- */

/** Wire echo for `--dry-run` envelopes (`share` and `unshare`). */
export type ShareWould = {
  method: 'GET' | 'DELETE';
  path: string;
  body: Record<string, unknown>;
};

/**
 * Sentinel `data.url` value emitted when `--dry-run` is passed to `share`.
 * The schema declares `url` as always-present `string`, but on dry-run we
 * have nothing to echo (no wire call happened). The bracketed placeholder
 * is unambiguous to humans and stable to match against for agents.
 *
 * Tests assert this exact literal. Spec 0050 decision 4.
 */
export const DRY_RUN_URL_PLACEHOLDER = '<dry-run: not yet known>';

/**
 * `freelo.tasks.share/v1` envelope `data`.
 *
 * - `task_id` — echo of `<id>` positional. Always present.
 * - `url`     — public URL on the live path; `DRY_RUN_URL_PLACEHOLDER` on
 *               dry-run. Always present.
 * - `created` — Freelo's `GET /public-link/task/{id}` collapses "first
 *               call (creates)" and "Nth call (returns existing)" into a
 *               single 200; the wire cannot distinguish. We surface this
 *               honestly: always `null` on the live path, also `null` on
 *               dry-run. Slot reserved for forward-compat. Always present.
 * - `would`   — present iff `--dry-run`.
 */
export type TasksShareData = {
  task_id: number;
  url: string;
  created: boolean | null;
  would?: ShareWould;
};

/**
 * `freelo.tasks.unshare/v1` envelope `data`.
 *
 * - `task_id`                 — echo of `<id>` positional. Always present.
 * - `already_in_target_state` — `true` only on the defensive 404 path;
 *                               `false` on the live 200 path. Spec 0050
 *                               decision 5 (mirrors R13 / R35 idempotency).
 * - `would`                   — present iff `--dry-run`.
 */
export type TasksUnshareData = {
  task_id: number;
  already_in_target_state: boolean;
  would?: ShareWould;
};
