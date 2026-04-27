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
