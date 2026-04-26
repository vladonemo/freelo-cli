import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import {
  ProjectsBareArraySchema,
  ProjectFullSchema,
  ProjectWithTasklistsSchema,
  ProjectDetailSchema,
  UserBasicSchema,
  type ProjectFull,
  type ProjectWithTasklists,
  type ProjectDetail,
  type UserBasic,
} from './schemas/project.js';
import { type NormalizedPage, normalizePaginated, synthesizeUnpaginated } from './pagination.js';

export type FetchOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type FetchPagedOpts = FetchOpts & {
  /** 0-indexed page; mapped to `?p=N` on the wire. */
  page: number;
};

export type ProjectsListResult<T> = {
  page: NormalizedPage<T>;
  raw: ApiResponse<unknown>;
};

/**
 * `GET /projects` — bare array, no server-side pagination.
 * Spec 0009 §2.2 + §4.1: synthesize a single-page NormalizedPage so every
 * scope speaks the same envelope shape.
 */
export async function getOwnedProjects(
  client: HttpClient,
  opts: FetchOpts,
): Promise<ProjectsListResult<ProjectWithTasklists>> {
  const raw = await client.request({
    method: 'GET',
    path: '/projects',
    schema: ProjectsBareArraySchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = synthesizeUnpaginated(raw.data);
  return { page, raw };
}

/**
 * `GET /all-projects?p=N` — paginated; rich `ProjectFull` items under
 * `data.projects`.
 */
export async function getAllProjects(
  client: HttpClient,
  opts: FetchPagedOpts,
): Promise<ProjectsListResult<ProjectFull>> {
  const path = `/all-projects?p=${opts.page}`;
  const raw = await client.request({
    method: 'GET',
    path,
    schema: z.unknown(),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = normalizePaginated(raw.data, 'projects', ProjectFullSchema);
  return { page, raw };
}

/** `GET /invited-projects?p=N` — paginated; inner key `invited_projects`. */
export async function getInvitedProjects(
  client: HttpClient,
  opts: FetchPagedOpts,
): Promise<ProjectsListResult<ProjectWithTasklists>> {
  const raw = await client.request({
    method: 'GET',
    path: `/invited-projects?p=${opts.page}`,
    schema: z.unknown(),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = normalizePaginated(raw.data, 'invited_projects', ProjectWithTasklistsSchema);
  return { page, raw };
}

/** `GET /archived-projects?p=N` — paginated; inner key `archived_projects`. */
export async function getArchivedProjects(
  client: HttpClient,
  opts: FetchPagedOpts,
): Promise<ProjectsListResult<ProjectWithTasklists>> {
  const raw = await client.request({
    method: 'GET',
    path: `/archived-projects?p=${opts.page}`,
    schema: z.unknown(),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = normalizePaginated(raw.data, 'archived_projects', ProjectWithTasklistsSchema);
  return { page, raw };
}

/** `GET /template-projects?p=N` — paginated; inner key `template_projects`. */
export async function getTemplateProjects(
  client: HttpClient,
  opts: FetchPagedOpts,
): Promise<ProjectsListResult<ProjectWithTasklists>> {
  const raw = await client.request({
    method: 'GET',
    path: `/template-projects?p=${opts.page}`,
    schema: z.unknown(),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = normalizePaginated(raw.data, 'template_projects', ProjectWithTasklistsSchema);
  return { page, raw };
}

/* ------------------------------------------------------------------------- *
 *  R04 — `freelo projects show <id>` (spec 0013)
 * ------------------------------------------------------------------------- */

/**
 * `GET /project/{id}` — returns the rich `ProjectDetail` shape (extends
 * ProjectFull with embedded `tasklists[*].tasks[]` and `workers[*]` carrying
 * each worker's `hour_rate`). Not paginated; one round-trip per call.
 *
 * Spec 0013 §4.3.
 */
export async function getProjectDetail(
  client: HttpClient,
  projectId: number,
  opts: FetchOpts,
): Promise<ApiResponse<ProjectDetail>> {
  return client.request({
    method: 'GET',
    path: `/project/${projectId}`,
    schema: ProjectDetailSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
}

/**
 * `GET /project/{id}/workers?p=N` — paginated; inner key `workers`, items
 * are `UserBasic` (id + fullname only — no `hour_rate` here, that lives on
 * `ProjectDetail.workers`).
 *
 * Reuses R03's `normalizePaginated` to produce the standard
 * `NormalizedPage<UserBasic>` shape so the command can drive `fetchAllPages`
 * without bespoke pagination logic.
 *
 * Spec 0013 §4.3.
 */
export async function getProjectWorkers(
  client: HttpClient,
  projectId: number,
  opts: FetchPagedOpts,
): Promise<{ page: NormalizedPage<UserBasic>; raw: ApiResponse<unknown> }> {
  const raw = await client.request({
    method: 'GET',
    path: `/project/${projectId}/workers?p=${opts.page}`,
    schema: z.unknown(),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = normalizePaginated(raw.data, 'workers', UserBasicSchema);
  return { page, raw };
}
