import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';

/**
 * Wire wrappers for R11 `tasks finish` / `tasks reopen`.
 *
 * Both endpoints take an empty body and return `SuccessResponse` (per
 * OpenAPI :1789-1840 — no echo of the new task state). The CLI computes the
 * new state from the verb and the pre-check observation; the response body
 * carries no information beyond `{ result: 'success' }`.
 *
 * Spec 0021 §2.1 / §2.2.
 */

/**
 * Generic Freelo success envelope (`{ result: 'success' }`). Tolerates
 * additional fields via `passthrough()` — Freelo extends success bodies
 * occasionally without a contract bump (mirrors `tasks-edit.ts`).
 */
const SuccessResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

export type TransitionVerb = 'finish' | 'reopen';

/**
 * Resolve the wire path for a transition verb. `'reopen'` maps to the API's
 * `activate` endpoint (OpenAPI :1789); `'finish'` maps to `/finish`
 * (OpenAPI :1815).
 *
 * Exposed so `--dry-run` envelopes can echo the path without re-running this
 * branch.
 */
export function transitionPath(verb: TransitionVerb, taskId: number): string {
  return verb === 'finish' ? `/task/${taskId}/finish` : `/task/${taskId}/activate`;
}

export type TransitionOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type TransitionResult = {
  raw: ApiResponse<unknown>;
};

/**
 * `POST /task/{task_id}/finish` — closes the task.
 *
 * Empty request body. Response is `SuccessResponse`; the CLI does not surface
 * it (it derives `current_state` from the verb).
 *
 * Spec 0021 §2.1 / OpenAPI :1815-1840.
 */
export async function finishTask(
  client: HttpClient,
  taskId: number,
  opts: TransitionOpts = {},
): Promise<TransitionResult> {
  const raw = await client.request({
    method: 'POST',
    path: transitionPath('finish', taskId),
    body: {},
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}

/**
 * `POST /task/{task_id}/activate` — reopens a finished task.
 *
 * Empty request body. Response is `SuccessResponse`. **Already-active task →
 * 200** (natural idempotency, OpenAPI :1802) — but the CLI never reaches here
 * for an already-active task because the pre-check short-circuits first
 * (spec 0021 decision 1).
 *
 * Note on naming: the wire path is `/activate`, but the CLI verb is
 * `'reopen'`. `tasks activate` would clash with archive-restore semantics
 * later (the project activate endpoint, OpenAPI :649, IS undelete). Keeping
 * the CLI label distinct prevents that ambiguity.
 *
 * Spec 0021 §2.2 / OpenAPI :1789-1813.
 */
export async function activateTask(
  client: HttpClient,
  taskId: number,
  opts: TransitionOpts = {},
): Promise<TransitionResult> {
  const raw = await client.request({
    method: 'POST',
    path: transitionPath('reopen', taskId),
    body: {},
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
