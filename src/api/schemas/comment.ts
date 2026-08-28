import { z } from 'zod';
import { UserBasicSchema } from './project.js';

/**
 * Zod schemas for the `comments` resource group, R16 (spec 0027).
 *
 * Wire shape: `CommentFull` from OpenAPI :5607-5667 — the response item type
 * for `GET /all-comments`. Discriminated only by which of `task` / `document`
 * / `file` / `link` is non-null on a given row (no explicit `kind` field).
 *
 * `.passthrough()` is applied on every entity-link block so future API
 * additions (e.g. a new comment-target type) don't break validation. The
 * top-level CommentFullSchema is also passthrough — server may add fields
 * like `reactions`, `mentions`, etc. without breaking the CLI.
 */

/**
 * Minimal entity-link block shared by `task`, `document`, `link`, `file`.
 * Each is `.nullable().optional()` on `CommentFull` itself.
 */
const TaskRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

const TasklistRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

const ProjectRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

const DocumentRefSchema = z
  .object({
    uuid: z.string(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

const LinkRefSchema = z
  .object({
    uuid: z.string(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

const FileRefSchema = z
  .object({
    uuid: z.string(),
  })
  .passthrough();

const FileFullRefSchema = z
  .object({
    uuid: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * `CommentFull` — single item in the `/all-comments` paginated response
 * (OpenAPI :5607-5667). All fields are loose:
 *
 * - `id` and `uuid` are documented `nullable` (the API may return rows with
 *   only one identifier on certain comment types).
 * - `content` is required (`type: string`); empty string is permitted.
 * - `date_add` and `date_edited_at` are required ISO datetimes (`date-time`).
 * - `author` is required and matches `UserBasic` (id + nullable fullname).
 * - Every entity-link block is `.nullable().optional()` to match the spec's
 *   "exactly one of these populated" discriminator (see §3.4 in spec 0027).
 *
 * `.passthrough()` so future additions (reactions, mentions, etc.) don't
 * break validation. Per spec 0027 decision 15.
 */
export const CommentFullSchema = z
  .object({
    id: z.number().int().nullable().optional(),
    uuid: z.string().nullable().optional(),
    content: z.string(),
    date_add: z.string(),
    date_edited_at: z.string(),
    author: UserBasicSchema,
    task: TaskRefSchema.nullable().optional(),
    tasklist: TasklistRefSchema.nullable().optional(),
    project: ProjectRefSchema.nullable().optional(),
    document: DocumentRefSchema.nullable().optional(),
    link: LinkRefSchema.nullable().optional(),
    file: FileRefSchema.nullable().optional(),
    files: z.array(FileFullRefSchema).optional(),
  })
  .passthrough();

export type CommentFull = z.infer<typeof CommentFullSchema>;

/**
 * `freelo.comments.list/v1` envelope `data.applied_filters` shape.
 *
 * Always an object (possibly empty `{}`). Only keys the user explicitly set
 * are emitted — unset keys are omitted, mirroring `tasks list`'s
 * `applied_filters` precedent. Spec 0027 decision 4.
 */
export const CommentsListAppliedFiltersSchema = z.object({
  projects: z.array(z.number().int()).optional(),
  type: z.enum(['all', 'task', 'document', 'file', 'link']).optional(),
  order_by: z.enum(['date_add', 'date_edited_at']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  since: z.string().optional(),
});
export type CommentsListAppliedFilters = z.infer<typeof CommentsListAppliedFiltersSchema>;

/**
 * `freelo.comments.list/v1` envelope `data` shape.
 *
 *   - `applied_filters`: echo of the user's parsed flags (see above).
 *   - `comments`: post-filtered `CommentFull` array (`--since` post-filter
 *     applies before the array reaches the envelope).
 *
 * `paging` and `rate_limit` travel at the envelope level. `paging.per_page` /
 * `paging.total` reflect server-side wire values — the post-filter does not
 * mutate them (spec 0027 decision 7).
 *
 * Spec 0027 §3.3 / §4.1.1.
 */
export const CommentsListDataSchema = z.object({
  applied_filters: CommentsListAppliedFiltersSchema,
  comments: z.array(CommentFullSchema),
});
export type CommentsListData = z.infer<typeof CommentsListDataSchema>;

/* ---------------------------------------------------------------------------
 *  R17 — `freelo comments add` (spec 0028)
 *
 *  Singleton response from `POST /task/{task_id}/comments`. We declare a
 *  separate schema (rather than reusing `CommentFullSchema` from R16)
 *  because:
 *    - `CommentFull` requires `date_edited_at` (used by R16's `--since`
 *      filter); the singleton POST response may not always include it.
 *    - `CommentFull` is shaped for `/all-comments` rows that always carry an
 *      entity-link block; the singleton POST response does not.
 *    - Touching `CommentFullSchema` would risk regressing R16's contract.
 *
 *  Spec 0028 §2.2 / §3.2.
 * ------------------------------------------------------------------------- */

/**
 * Singleton `Comment` response from `POST /task/{task_id}/comments`.
 *
 * Loose by design (passthrough; nullable+optional on most fields). The only
 * required field is `content` — the API guarantees it on a 200 response.
 *
 * `is_description` is the load-bearing field for the description-flip case
 * (yaml :2589-2592 — "if the task has no comments yet, this call creates
 * the task's description instead of a regular comment"). When true, the
 * envelope's pulled-up `data.is_description` echoes it.
 *
 * Spec 0028 §2.2.
 */
export const CommentCreatedSchema = z
  .object({
    id: z.number().int().nullable().optional(),
    uuid: z.string().nullable().optional(),
    content: z.string(),
    date_add: z.string().nullable().optional(),
    date_edited_at: z.string().nullable().optional(),
    is_description: z.boolean().nullable().optional(),
    author: UserBasicSchema.nullable().optional(),
  })
  .passthrough();

export type CommentCreated = z.infer<typeof CommentCreatedSchema>;

/**
 * Source of the content for `comments add`. Echoed in the envelope so agents
 * can verify which input source produced the body.
 *
 *   - `'message'` — `--message <str>` (inline pass-through).
 *   - `'file'`    — `--from-file <path>`.
 *   - `'editor'`  — `--editor` (TTY-only).
 *   - `'stdin'`   — `-` (positional sentinel).
 *
 * Distinct from R15's `SetDescriptionSourceSchema` (which lacks `'message'`).
 * R17 owns its own enum so R15's contract is untouched. Spec 0028 decision 4.
 */
export const AddCommentSourceSchema = z.enum(['message', 'file', 'editor', 'stdin']);
export type AddCommentSource = z.infer<typeof AddCommentSourceSchema>;

/* ---------------------------------------------------------------------------
 *  R18 — `freelo comments edit` (spec 0029)
 *
 *  POST /comment/{comment_id} (yaml :2619-2663). Same `Comment` response
 *  shape as R17's `createComment` — we reuse `CommentCreatedSchema` rather
 *  than declaring a parallel one. Only the source enum and the envelope
 *  data shape are R18-specific.
 *
 *  Spec 0029 §3.4 / decision 4.
 * ------------------------------------------------------------------------- */

/**
 * Source of the content for `comments edit`. Strict superset of R17's
 * `AddCommentSourceSchema`:
 *
 *   - `'message'` — `--message <str>` (inline pass-through, shared content
 *     across every id in batch).
 *   - `'file'`    — `--from-file <path>` (shared content across every id).
 *   - `'editor'`  — `--editor` (TTY-only; shared content across every id).
 *   - `'stdin'`   — single id with `-` positional sentinel.
 *   - `'ndjson'`  — `--stdin` batch mode; per-row `content` from each line.
 *
 * R17's enum is **untouched** — adding `'ndjson'` to it would be a
 * passthrough-schema breaking change for R17's envelope. R18 owns its own
 * enum (decision 4).
 */
export const EditCommentSourceSchema = z.enum(['message', 'file', 'editor', 'stdin', 'ndjson']);
export type EditCommentSource = z.infer<typeof EditCommentSourceSchema>;

/**
 * `freelo.comments.edit/v1` envelope `data` shape.
 *
 *   - `comment_id`: target comment id (echoed; always present).
 *   - `comment`: server response (post-edit), validated through
 *     `CommentCreatedSchema`. **Always present** in live envelopes; **absent**
 *     in `--dry-run`.
 *   - `source`: `'message' | 'file' | 'editor' | 'stdin' | 'ndjson'`.
 *     **Always present** in live; **absent** in `--dry-run`.
 *   - `byte_length`: UTF-8 byte length of the content sent (or that would have
 *     been sent in dry-run). **Always present**.
 *   - `line_index`: 0-indexed line number in `--stdin` batch mode. **Present
 *     only** for NDJSON-derived envelopes; **absent** for positional / --ids /
 *     single-id flows.
 *   - `would`: only in `--dry-run` envelopes (mirrors R09 / R13 / R15 / R17).
 *
 * No `is_description` echo: edit cannot flip a comment to/from a description
 * (server-side that's handled by the original create call only).
 *
 * Spec 0029 §3.2.
 */
export const CommentsEditDataSchema = z.object({
  comment_id: z.number().int(),
  comment: CommentCreatedSchema.optional(),
  source: EditCommentSourceSchema.optional(),
  byte_length: z.number().int().nonnegative(),
  line_index: z.number().int().nonnegative().optional(),
  would: z
    .object({
      method: z.literal('POST'),
      path: z.string(),
      body: z.object({ content: z.string() }),
    })
    .optional(),
});
export type CommentsEditData = z.infer<typeof CommentsEditDataSchema>;

/**
 * `freelo.comments.add/v1` envelope `data` shape.
 *
 *   - `task_id`: target task id (echoed).
 *   - `comment`: server response (post-create), validated through
 *     `CommentCreatedSchema`. **Always present** in live envelopes; **absent**
 *     in `--dry-run`.
 *   - `source`: `'message' | 'file' | 'editor' | 'stdin'`. **Always present**
 *     in live; **absent** in `--dry-run`.
 *   - `byte_length`: UTF-8 byte length of the content sent (or that would have
 *     been sent in dry-run). **Always present**.
 *   - `is_description`: pulled-up boolean (defaults to `false` when the
 *     server omits the field). True ⇔ this POST flipped to description due to
 *     the empty-comments precondition (spec 0028 §3.2 / decision 3).
 *     **Always present** in live envelopes; **absent** in `--dry-run`.
 *   - `would`: only in `--dry-run` envelopes (mirrors R09 / R13 / R15).
 *
 * Spec 0028 §3.2.
 */
export const CommentsAddDataSchema = z.object({
  task_id: z.number().int(),
  comment: CommentCreatedSchema.optional(),
  source: AddCommentSourceSchema.optional(),
  byte_length: z.number().int().nonnegative(),
  is_description: z.boolean().optional(),
  would: z
    .object({
      method: z.literal('POST'),
      path: z.string(),
      body: z.unknown(),
    })
    .optional(),
});
export type CommentsAddData = z.infer<typeof CommentsAddDataSchema>;

/**
 * `freelo.comments.delete/v1` envelope `data` shape (M01, spec 0061 §4.1).
 *
 *   - `comment_id`: target comment id (echoed). **Always present.**
 *   - `current_state`: always `'deleted'` — derived from the verb, not from
 *     the response. `DELETE /comment/{id}` declares no 200 response schema
 *     (yaml :3227-3228), so there is nothing server-derived to surface.
 *   - `already_in_target_state`: **always `false` in v1.** Unlike
 *     `tasks delete` (R13), a 404 here is NOT absorbed into an idempotent
 *     success — per yaml :3216 it means *either* "no such comment" *or* "you
 *     are not its author", so absorbing it would report success for a comment
 *     still sitting in the thread (spec 0061 §5.1 / decision 1). The field is
 *     retained anyway so agents looping deletes across `tasks` / `projects` /
 *     `labels` / `comments` read one field shape everywhere.
 *
 *     Typed `z.boolean()` rather than `z.literal(false)` on purpose: if Freelo
 *     ever lets us distinguish the two 404 causes, widening a `false` literal
 *     to `boolean` would be a retype — a breaking envelope change. `boolean`
 *     keeps that door open at zero cost.
 *   - `would`: only in `--dry-run` envelopes (mirrors R09 / R13 / R15 / R17).
 *   - `line_index`: 0-indexed line number in `--stdin` batch mode. **Present
 *     only** for NDJSON-derived envelopes; **absent** for positional / --ids /
 *     single-id flows.
 *
 * No `previous_state`: in `TasksDeleteData` that is a task-lifecycle enum the
 * delete path hardcodes to `null` anyway, and comments have no lifecycle enum
 * — it would be null-typed noise on a brand-new schema (decision 3).
 *
 * Spec 0061 §4.1.
 */
export const CommentsDeleteDataSchema = z.object({
  comment_id: z.number().int(),
  current_state: z.literal('deleted'),
  already_in_target_state: z.boolean(),
  would: z
    .object({
      method: z.literal('DELETE'),
      path: z.string(),
      body: z.unknown(),
    })
    .optional(),
  line_index: z.number().int().min(0).optional(),
});
export type CommentsDeleteData = z.infer<typeof CommentsDeleteDataSchema>;
