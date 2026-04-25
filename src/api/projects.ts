import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import {
  ProjectsBareArraySchema,
  ProjectFullSchema,
  ProjectWithTasklistsSchema,
  type ProjectFull,
  type ProjectWithTasklists,
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
