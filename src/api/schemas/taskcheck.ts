import { z } from 'zod';

/**
 * Schemas for M03 — `freelo taskchecks` (spec 0066).
 *
 * A **taskcheck** in this file always means a *simple* checklist item: a
 * `tasks_checks` row with no smart-task counterpart (`task_id: null`). It is
 * the fallback form `POST /task/{id}/subtasks` produces when the parent's
 * tasklist cannot host smart subtasks (`src/api/subtasks.ts:41-48`).
 *
 * **Two disjoint id spaces.** A *smart* taskcheck has its own `tasks.id` and
 * returns 404 on every `/taskcheck/{id}…` path; it is managed through
 * `freelo tasks edit|delete|finish|reopen`. Both id spaces are plain integers
 * from independent sequences, so the kind is not inferable from the id. The
 * CLI deliberately does not probe or fall back — spec 0066 §3 / decision 2.
 */

/* ---------------------------------------------------------------------------
 *  Wire response
 * ------------------------------------------------------------------------- */

/**
 * All four taskcheck operations declare exactly one response: `200` →
 * `SuccessResponse` (yaml :2149-2155, :2165-2171, :2198-2204, :2216-2222).
 * There is no entity in the body — no id echo, no state, no discriminator — so
 * nothing here is surfaced to the user; the envelope's `current_state` is
 * derived from the verb instead.
 *
 * Parsed defensively anyway so a malformed 2xx still trips validation. Mirrors
 * `src/api/files-delete.ts:37-41` and `src/api/comments-delete.ts`.
 */
export const TaskcheckSuccessSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

/* ---------------------------------------------------------------------------
 *  Edit input / body
 * ------------------------------------------------------------------------- */

/**
 * CLI-side input for `freelo taskchecks edit`.
 *
 * Deliberately tiny. `POST /taskcheck/{id}` accepts **only** `name` and
 * `worker`; `priority_enum`, `priority`, `due_date` and `due_date_end` return
 * 400 (yaml :2124). R10's `tasks edit` flag set is NOT reused — spec 0066 §4.1.
 */
export type EditTaskcheckInput = {
  name?: string;
  /** User id to assign as worker. Mutex with `clearWorker`. */
  worker?: number;
  /** Emits `worker: null` — the documented clearing value (yaml :2140). */
  clearWorker?: true;
  notifyAuthor?: true;
};

/**
 * Wire body for `POST /taskcheck/{taskcheck_id}` (yaml :2128-2148).
 *
 * `worker: null` is the explicit-clear signal. Keys are emitted only when the
 * user set them, so an omitted flag leaves the field untouched server-side
 * (R07's filter-omit convention).
 */
export type EditTaskcheckBody = {
  name?: string;
  worker?: number | null;
  notify_author?: true;
};

/* ---------------------------------------------------------------------------
 *  Envelope data shapes
 *
 *  None of these carry `previous_state` or `already_in_target_state`.
 *  That is deliberate and load-bearing (spec 0066 §5.2 / decision 5): the API
 *  declares no `GET /taskcheck/{id}`, and a taskcheck id does not reveal its
 *  parent task's id, so `GET /task/{parent}/subtasks` is unreachable too. A
 *  simple checklist item's prior state is **unobservable to this CLI**.
 *  `freelo.files.delete/v1` pins `already_in_target_state` to `false` for
 *  cross-command uniformity and its own renderer calls that value
 *  "unreachable-true"; here the question is not merely unanswered but
 *  unanswerable, so emitting `false` would assert knowledge we do not have.
 *  Omission is the honest encoding — a consumer reading `undefined` correctly
 *  learns nothing.
 * ------------------------------------------------------------------------- */

/** Echo of the call `--dry-run` would have made. */
const WouldSchema = z.object({
  method: z.enum(['POST', 'DELETE']),
  path: z.string(),
  body: z.unknown(),
});

/**
 * `freelo.taskchecks.edit/v1`.
 *
 * `applied_changes` lists the CLI-level fields that were actually sent
 * (`'name'`, `'worker'`, `'clear_worker'`), so an agent can confirm what it
 * asked for without re-deriving it from its own argv. The endpoint's 200 body
 * carries no entity, so this is an echo of intent, not a server confirmation —
 * documented as such in `docs/commands/taskchecks.md`.
 */
export const TaskchecksEditDataSchema = z.object({
  taskcheck_id: z.number().int(),
  applied_changes: z.array(z.enum(['name', 'worker', 'clear_worker'])),
  notify_author: z.boolean(),
  would: WouldSchema.optional(),
});
export type TaskchecksEditData = z.infer<typeof TaskchecksEditDataSchema>;

/**
 * `freelo.taskchecks.delete/v1`.
 *
 * `current_state` is derived from the verb — the 200 body carries no state.
 * Soft-delete; there is no undelete endpoint.
 */
export const TaskchecksDeleteDataSchema = z.object({
  taskcheck_id: z.number().int(),
  current_state: z.literal('deleted'),
  would: WouldSchema.optional(),
  /** Present only in `--stdin` batch mode: the 0-based input line index. */
  line_index: z.number().int().min(0).optional(),
});
export type TaskchecksDeleteData = z.infer<typeof TaskchecksDeleteDataSchema>;

/**
 * Envelope `data` shared by `freelo.taskchecks.finish/v1` and
 * `freelo.taskchecks.reopen/v1` (mirrors R11's shared
 * `TasksTransitionDataSchema`, minus the state-observation fields R11 can
 * populate and this resource cannot).
 *
 * `notify_author` is always `false` for `reopen`: `POST /taskcheck/{id}/activate`
 * declares no request body at all (yaml :2206-2222), so there is nothing to
 * send. See decision 3.
 */
export const TaskchecksTransitionDataSchema = z.object({
  taskcheck_id: z.number().int(),
  verb: z.enum(['finish', 'reopen']),
  current_state: z.enum(['finished', 'active']),
  notify_author: z.boolean(),
  would: WouldSchema.optional(),
  line_index: z.number().int().min(0).optional(),
});
export type TaskchecksTransitionData = z.infer<typeof TaskchecksTransitionDataSchema>;
