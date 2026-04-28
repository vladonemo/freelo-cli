import { http, HttpResponse, type RequestHandler } from 'msw';
import { setupServer } from 'msw/node';

export const API_BASE = 'https://api.freelo.io/v1';

const USERS_ME_URL = `${API_BASE}/users/me`;

const OK_MINIMAL = { result: 'success', user: { id: 12345 } };

/**
 * MSW handler factories for `GET /users/me`.
 */
export const usersMeHandlers = {
  /** 200 with the minimal fixture (or a custom user object). */
  ok(user?: Record<string, unknown>): RequestHandler {
    const body = user ? { result: 'success', user: { id: 12345, ...user } } : OK_MINIMAL;
    return http.get(USERS_ME_URL, () => HttpResponse.json(body));
  },

  /** 200 with an extended user object (email, fullname, avatar). */
  okExtended(
    user: Record<string, unknown> = {
      id: 12345,
      email: 'jane@example.cz',
      fullname: 'Jane Doe',
      avatar_url: 'https://static.freelo.io/avatars/default.png',
    },
  ): RequestHandler {
    return http.get(USERS_ME_URL, () => HttpResponse.json({ result: 'success', user }));
  },

  /** 401 — object-form errors (`[{ message }]`). */
  unauthorized(): RequestHandler {
    return http.get(USERS_ME_URL, () =>
      HttpResponse.json({ errors: [{ message: 'Invalid token' }] }, { status: 401 }),
    );
  },

  /** 401 — string-form errors (global ErrorResponse shape). */
  unauthorizedGlobal(): RequestHandler {
    return http.get(USERS_ME_URL, () =>
      HttpResponse.json({ errors: ['Invalid token'] }, { status: 401 }),
    );
  },

  /** 429 with optional `Retry-After` header. */
  rateLimited(opts?: { retryAfter?: string }): RequestHandler {
    return http.get(
      USERS_ME_URL,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            ...(opts?.retryAfter ? { 'Retry-After': opts.retryAfter } : {}),
          },
        }),
    );
  },

  /** 5xx server error. */
  serverError(status = 500): RequestHandler {
    return http.get(USERS_ME_URL, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** Malformed 200 — missing required `user.id`. */
  malformed(): RequestHandler {
    return http.get(USERS_ME_URL, () =>
      HttpResponse.json({ result: 'success', user: { name: 'oops' } }),
    );
  },
};

/**
 * Project list endpoint URLs (R03).
 *
 * Spec 0009 §2.2 maps `--scope` to one of these endpoints. All accept the
 * `?p=N` page query parameter except `/projects` which is unpaginated.
 */
export const PROJECTS_URLS = {
  owned: `${API_BASE}/projects`,
  all: `${API_BASE}/all-projects`,
  invited: `${API_BASE}/invited-projects`,
  archived: `${API_BASE}/archived-projects`,
  templates: `${API_BASE}/template-projects`,
} as const;

type PagedScope = Exclude<keyof typeof PROJECTS_URLS, 'owned'>;
type PagedFixture = {
  total: number;
  count: number;
  page: number;
  per_page: number;
  data: Record<string, unknown[]>;
};

/**
 * MSW handlers for the five project list endpoints.
 *
 * Each `*Ok` factory takes a body (or pages) and returns a handler that
 * matches the URL and answers with the body. The four paged handlers
 * dispatch on the `p` query parameter so a single test can drive multi-page
 * scenarios from a single `server.use(...)` call.
 */
export const projectsHandlers = {
  /** `GET /projects` (bare array, no paging). */
  ownedOk(items: unknown[]): RequestHandler {
    return http.get(PROJECTS_URLS.owned, () => HttpResponse.json(items));
  },

  /**
   * Paged endpoint factory. `pages` is keyed by the page index; missing
   * pages return the last-known body (so out-of-range queries surface as
   * empty pages with the same paging metadata, matching spec §5
   * "page past last page").
   */
  pagedOk(scope: PagedScope, pages: Record<number, PagedFixture>): RequestHandler {
    const url = PROJECTS_URLS[scope];
    return http.get(url, ({ request }) => {
      const u = new URL(request.url);
      const p = Number(u.searchParams.get('p') ?? '0');
      const known = Object.keys(pages)
        .map(Number)
        .sort((a, b) => a - b);
      const lastKnown = known[known.length - 1] ?? 0;
      const fixture = pages[p];
      if (fixture !== undefined) return HttpResponse.json(fixture);
      // Past-end: synthesize an empty page using the last-known per_page/total.
      const ref = pages[lastKnown];
      if (!ref) {
        return HttpResponse.json({
          total: 0,
          count: 0,
          page: p,
          per_page: 25,
          data: {},
        });
      }
      const innerKey = Object.keys(ref.data)[0] ?? 'projects';
      return HttpResponse.json({
        total: ref.total,
        count: 0,
        page: p,
        per_page: ref.per_page,
        data: { [innerKey]: [] },
      });
    });
  },

  /** Returns 401 for the chosen scope's endpoint. */
  unauthorized(scope: keyof typeof PROJECTS_URLS): RequestHandler {
    return http.get(PROJECTS_URLS[scope], () =>
      HttpResponse.json({ errors: ['Invalid token'] }, { status: 401 }),
    );
  },

  /** Returns a 5xx for the chosen scope's endpoint. */
  serverError(scope: keyof typeof PROJECTS_URLS, status = 500): RequestHandler {
    return http.get(PROJECTS_URLS[scope], () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** Returns a wrapper missing the inner data key (paginated scopes only). */
  malformedWrapper(scope: PagedScope): RequestHandler {
    return http.get(PROJECTS_URLS[scope], () =>
      HttpResponse.json({ total: 0, count: 0, page: 0, per_page: 25, data: {} }),
    );
  },

  /**
   * Mid-stream `--all` failure: succeeds for `p < failPage`, errors at `p === failPage`.
   * Used to drive the partial-result code path in `--all` json mode.
   */
  allMidStreamError(opts: {
    pages: Record<number, PagedFixture>;
    failPage: number;
    status?: number;
  }): RequestHandler {
    const { pages, failPage, status = 500 } = opts;
    return http.get(PROJECTS_URLS.all, ({ request }) => {
      const u = new URL(request.url);
      const p = Number(u.searchParams.get('p') ?? '0');
      if (p === failPage) {
        return HttpResponse.json({ errors: ['mid-stream'] }, { status });
      }
      const fixture = pages[p];
      if (fixture !== undefined) return HttpResponse.json(fixture);
      return HttpResponse.json({ errors: ['unexpected'] }, { status: 500 });
    });
  },
};

/**
 * MSW handlers for `freelo projects show <id>` (R04, spec 0013).
 *
 * Two endpoints:
 *   - `GET /project/{id}` — `ProjectDetail` (single object)
 *   - `GET /project/{id}/workers?p=N` — paginated `UserBasic[]`
 */
export const projectShowHandlers = {
  /** `GET /project/{id}` — 200 with the supplied detail body. */
  detailOk(projectId: number, body: Record<string, unknown>): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}`, () => HttpResponse.json(body));
  },

  /** `GET /project/{id}` — 404. */
  detailNotFound(projectId: number): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}`, () =>
      HttpResponse.json({ errors: ['Project not found.'] }, { status: 404 }),
    );
  },

  /** `GET /project/{id}` — 403. */
  detailForbidden(projectId: number): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  /** `GET /project/{id}` — 401. */
  detailUnauthorized(projectId: number): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `GET /project/{id}` — 5xx. */
  detailServerError(projectId: number, status = 500): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /**
   * `GET /project/{id}/workers?p=N` — paginated. `pages` is keyed by 0-indexed
   * page number; missing pages return an empty page using the last-known
   * `per_page` and `total` (mirrors the past-end behaviour of `pagedOk`).
   */
  workersPaged(projectId: number, pages: Record<number, PagedFixture>): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}/workers`, ({ request }) => {
      const u = new URL(request.url);
      const p = Number(u.searchParams.get('p') ?? '0');
      const known = Object.keys(pages)
        .map(Number)
        .sort((a, b) => a - b);
      const lastKnown = known[known.length - 1] ?? 0;
      const fixture = pages[p];
      if (fixture !== undefined) return HttpResponse.json(fixture);
      const ref = pages[lastKnown];
      if (!ref) {
        return HttpResponse.json({
          total: 0,
          count: 0,
          page: p,
          per_page: 25,
          data: { workers: [] },
        });
      }
      return HttpResponse.json({
        total: ref.total,
        count: 0,
        page: p,
        per_page: ref.per_page,
        data: { workers: [] },
      });
    });
  },

  /** `GET /project/{id}/workers` — 5xx for any page (not parameterised). */
  workersServerError(projectId: number, status = 500): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}/workers`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /**
   * Mid-stream `--with workers` failure: succeeds for `p < failPage`, errors
   * at `p === failPage`. Used to drive the partial-result code path in
   * `fetchAllPages`.
   */
  workersMidStreamError(opts: {
    projectId: number;
    pages: Record<number, PagedFixture>;
    failPage: number;
    status?: number;
  }): RequestHandler {
    const { projectId, pages, failPage, status = 500 } = opts;
    return http.get(`${API_BASE}/project/${projectId}/workers`, ({ request }) => {
      const u = new URL(request.url);
      const p = Number(u.searchParams.get('p') ?? '0');
      if (p === failPage) {
        return HttpResponse.json({ errors: ['mid-stream'] }, { status });
      }
      const fixture = pages[p];
      if (fixture !== undefined) return HttpResponse.json(fixture);
      return HttpResponse.json({ errors: ['unexpected'] }, { status: 500 });
    });
  },
};

/**
 * MSW handlers for `freelo tasklists list` (R05, spec 0014).
 *
 * Single endpoint: `GET /all-tasklists?p=N[&projects_ids[]=<id>]`. The
 * factories below mirror `projectsHandlers.pagedOk` shape so the tests can
 * drive multi-page and per-project scenarios from a single `server.use(...)`
 * call.
 */
export const tasklistsHandlers = {
  /**
   * `GET /all-tasklists?p=N` — paginated list. `pages` is keyed by 0-indexed
   * page number; missing pages return an empty page using the last-known
   * `per_page` and `total` (mirrors `projectsHandlers.pagedOk` past-end
   * behaviour).
   */
  allOk(pages: Record<number, PagedFixture>): RequestHandler {
    return http.get(`${API_BASE}/all-tasklists`, ({ request }) => {
      const u = new URL(request.url);
      const p = Number(u.searchParams.get('p') ?? '0');
      const known = Object.keys(pages)
        .map(Number)
        .sort((a, b) => a - b);
      const lastKnown = known[known.length - 1] ?? 0;
      const fixture = pages[p];
      if (fixture !== undefined) return HttpResponse.json(fixture);
      const ref = pages[lastKnown];
      if (!ref) {
        return HttpResponse.json({
          total: 0,
          count: 0,
          page: p,
          per_page: 25,
          data: { tasklists: [] },
        });
      }
      return HttpResponse.json({
        total: ref.total,
        count: 0,
        page: p,
        per_page: ref.per_page,
        data: { tasklists: [] },
      });
    });
  },

  /**
   * `GET /all-tasklists?projects_ids[]=<id>&p=N` — server-filtered to one
   * project. Returns `pages` when the request's `projects_ids[]` matches
   * `projectId`; returns an empty body otherwise (simulates ACL-filtered
   * "project not visible" or non-existent).
   */
  allByProject(projectId: number, pages: Record<number, PagedFixture>): RequestHandler {
    return http.get(`${API_BASE}/all-tasklists`, ({ request }) => {
      const u = new URL(request.url);
      const filterId = u.searchParams.get('projects_ids[]');
      const p = Number(u.searchParams.get('p') ?? '0');
      if (filterId !== String(projectId)) {
        return HttpResponse.json({
          total: 0,
          count: 0,
          page: p,
          per_page: 25,
          data: { tasklists: [] },
        });
      }
      const fixture = pages[p];
      if (fixture !== undefined) return HttpResponse.json(fixture);
      return HttpResponse.json({
        total: 0,
        count: 0,
        page: p,
        per_page: 25,
        data: { tasklists: [] },
      });
    });
  },

  /** Returns 401 for the tasklists endpoint. */
  unauthorized(): RequestHandler {
    return http.get(`${API_BASE}/all-tasklists`, () =>
      HttpResponse.json({ errors: ['Invalid token'] }, { status: 401 }),
    );
  },

  /** Returns 404. */
  notFound(): RequestHandler {
    return http.get(`${API_BASE}/all-tasklists`, () =>
      HttpResponse.json({ errors: ['Not found.'] }, { status: 404 }),
    );
  },

  /** Returns 5xx. */
  serverError(status = 500): RequestHandler {
    return http.get(`${API_BASE}/all-tasklists`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** Wrapper missing the inner `tasklists` data key. */
  malformedWrapper(): RequestHandler {
    return http.get(`${API_BASE}/all-tasklists`, () =>
      HttpResponse.json({ total: 0, count: 0, page: 0, per_page: 25, data: {} }),
    );
  },

  /**
   * Mid-stream `--all` failure: succeeds for `p < failPage`, errors at
   * `p === failPage`. Used to drive the partial-result code path in `--all`
   * json mode.
   */
  allMidStreamError(opts: {
    pages: Record<number, PagedFixture>;
    failPage: number;
    status?: number;
  }): RequestHandler {
    const { pages, failPage, status = 500 } = opts;
    return http.get(`${API_BASE}/all-tasklists`, ({ request }) => {
      const u = new URL(request.url);
      const p = Number(u.searchParams.get('p') ?? '0');
      if (p === failPage) {
        return HttpResponse.json({ errors: ['mid-stream'] }, { status });
      }
      const fixture = pages[p];
      if (fixture !== undefined) return HttpResponse.json(fixture);
      return HttpResponse.json({ errors: ['unexpected'] }, { status: 500 });
    });
  },
};

/**
 * MSW handlers for `freelo tasklists show <id>` (R06, spec 0016).
 *
 * Two endpoints:
 *   - `GET /tasklist/{id}` — `TasklistDetail` (single object)
 *   - `GET /project/{pid}/tasklist/{tid}/assignable-workers` — bare `UserBasic[]` (NOT paginated)
 */
export const tasklistShowHandlers = {
  /** `GET /tasklist/{id}` — 200 with the supplied detail body. */
  detailOk(tasklistId: number, body: Record<string, unknown>): RequestHandler {
    return http.get(`${API_BASE}/tasklist/${tasklistId}`, () => HttpResponse.json(body));
  },

  /** `GET /tasklist/{id}` — 404. */
  detailNotFound(tasklistId: number): RequestHandler {
    return http.get(`${API_BASE}/tasklist/${tasklistId}`, () =>
      HttpResponse.json({ errors: ['Tasklist not found.'] }, { status: 404 }),
    );
  },

  /** `GET /tasklist/{id}` — 403. */
  detailForbidden(tasklistId: number): RequestHandler {
    return http.get(`${API_BASE}/tasklist/${tasklistId}`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  /** `GET /tasklist/{id}` — 401. */
  detailUnauthorized(tasklistId: number): RequestHandler {
    return http.get(`${API_BASE}/tasklist/${tasklistId}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `GET /tasklist/{id}` — 5xx. */
  detailServerError(tasklistId: number, status = 500): RequestHandler {
    return http.get(`${API_BASE}/tasklist/${tasklistId}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /**
   * `GET /project/{pid}/tasklist/{tid}/assignable-workers` — 200 with the
   * supplied bare `UserBasic[]` array. Spec 0016 §2 / decision 1: the
   * endpoint returns an array directly, no pagination wrapper.
   */
  assignableWorkersOk(
    projectId: number,
    tasklistId: number,
    items: Array<{ id: number; fullname?: string | null }>,
  ): RequestHandler {
    return http.get(
      `${API_BASE}/project/${projectId}/tasklist/${tasklistId}/assignable-workers`,
      () => HttpResponse.json(items),
    );
  },

  /** Same endpoint — 404. */
  assignableWorkersNotFound(projectId: number, tasklistId: number): RequestHandler {
    return http.get(
      `${API_BASE}/project/${projectId}/tasklist/${tasklistId}/assignable-workers`,
      () => HttpResponse.json({ errors: ['Not found.'] }, { status: 404 }),
    );
  },

  /** Same endpoint — 403. */
  assignableWorkersForbidden(projectId: number, tasklistId: number): RequestHandler {
    return http.get(
      `${API_BASE}/project/${projectId}/tasklist/${tasklistId}/assignable-workers`,
      () => HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  /** Same endpoint — 5xx. */
  assignableWorkersServerError(
    projectId: number,
    tasklistId: number,
    status = 500,
  ): RequestHandler {
    return http.get(
      `${API_BASE}/project/${projectId}/tasklist/${tasklistId}/assignable-workers`,
      () => HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** Same endpoint — wrong shape (object wrapper instead of bare array). */
  assignableWorkersMalformed(projectId: number, tasklistId: number): RequestHandler {
    return http.get(
      `${API_BASE}/project/${projectId}/tasklist/${tasklistId}/assignable-workers`,
      () => HttpResponse.json({ data: { workers: [{ id: 9, fullname: 'Owner' }] } }),
    );
  },
};

/**
 * MSW handlers for `freelo tasks list` (R07, spec 0017).
 *
 * Two endpoints in v1:
 *   - `GET /all-tasks?<query>` — paginated; inner key `tasks`. Filters compose
 *     via `buildQuery` (`projects_ids[]=42&projects_ids[]=43`, etc.).
 *   - `GET /project/{p}/tasklist/{t}/tasks` — bare `TaskSummary[]`, NOT paginated.
 *
 * The `/tasklist/{id}/finished-tasks` route is deferred to R07.5 (spec OQ #4).
 */
export const tasksHandlers = {
  /**
   * `GET /all-tasks?p=N&...` — paginated. `pages` keyed by 0-indexed page
   * number; missing pages return an empty page with `total` from the last-
   * known fixture. Same past-end behaviour as `tasklistsHandlers.allOk`.
   */
  allTasksOk(pages: Record<number, PagedFixture>): RequestHandler {
    return http.get(`${API_BASE}/all-tasks`, ({ request }) => {
      const u = new URL(request.url);
      const p = Number(u.searchParams.get('p') ?? '0');
      const known = Object.keys(pages)
        .map(Number)
        .sort((a, b) => a - b);
      const lastKnown = known[known.length - 1] ?? 0;
      const fixture = pages[p];
      if (fixture !== undefined) return HttpResponse.json(fixture);
      const ref = pages[lastKnown];
      if (!ref) {
        return HttpResponse.json({
          total: 0,
          count: 0,
          page: p,
          per_page: 25,
          data: { tasks: [] },
        });
      }
      return HttpResponse.json({
        total: ref.total,
        count: 0,
        page: p,
        per_page: ref.per_page,
        data: { tasks: [] },
      });
    });
  },

  /**
   * `GET /all-tasks?<query>` with arbitrary URL-string assertion. Useful for
   * tests that need to validate the exact encoded query (test #2 / #4 / #5
   * style — cf. spec 0017 §8.4).
   *
   * `matchFn(url)` returns `true` when the request URL matches expectations;
   * the handler then responds with `response`. On no-match, returns 500 with
   * a diagnostic body so a test failure points at the offending URL.
   */
  allTasksByQuery(matchFn: (url: URL) => boolean, response: PagedFixture): RequestHandler {
    return http.get(`${API_BASE}/all-tasks`, ({ request }) => {
      const u = new URL(request.url);
      if (!matchFn(u)) {
        return HttpResponse.json(
          { errors: [`URL did not match assertion: ${u.searchParams.toString()}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json(response);
    });
  },

  /**
   * `GET /project/{pid}/tasklist/{tid}/tasks` — 200 with the bare array.
   * Spec 0017 §4.3 — endpoint returns an array directly, no wrapper.
   */
  tasklistTasksOk(
    projectId: number,
    tasklistId: number,
    items: Array<Record<string, unknown>>,
  ): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}/tasklist/${tasklistId}/tasks`, () =>
      HttpResponse.json(items),
    );
  },

  /** `GET /all-tasks` — 401. */
  unauthorized(): RequestHandler {
    return http.get(`${API_BASE}/all-tasks`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `GET /all-tasks` — configurable 5xx. */
  serverError(status = 500): RequestHandler {
    return http.get(`${API_BASE}/all-tasks`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /**
   * `GET /all-tasks` — always returns 429. Combined with the HttpClient's
   * three-attempt retry budget, this surfaces a `RateLimitedError` (exit 6).
   */
  rateLimited(): RequestHandler {
    return http.get(
      `${API_BASE}/all-tasks`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /**
   * `GET /all-tasks` — closes the connection without a response so undici
   * raises a network error. The HttpClient surfaces this as `NetworkError`
   * (exit 5). Spec 0017 §5 mandatory test #32.
   */
  networkError(): RequestHandler {
    return http.get(`${API_BASE}/all-tasks`, () => HttpResponse.error());
  },

  /**
   * Mid-stream `--all` failure: succeeds for `p < failPage`, errors at
   * `p === failPage`. Drives the partial-result code path (spec 0017 §5,
   * mandatory test #35). Same shape as `tasklistsHandlers.allMidStreamError`.
   */
  allMidStreamError(opts: {
    pages: Record<number, PagedFixture>;
    failPage: number;
    status?: number;
  }): RequestHandler {
    const { pages, failPage, status = 500 } = opts;
    return http.get(`${API_BASE}/all-tasks`, ({ request }) => {
      const u = new URL(request.url);
      const p = Number(u.searchParams.get('p') ?? '0');
      if (p === failPage) {
        return HttpResponse.json({ errors: ['mid-stream'] }, { status });
      }
      const fixture = pages[p];
      if (fixture !== undefined) return HttpResponse.json(fixture);
      return HttpResponse.json({ errors: ['unexpected'] }, { status: 500 });
    });
  },

  /**
   * Wrapper missing the inner `tasks` data key. Surfaces as `FreeloApiError`
   * with code `VALIDATION_ERROR` (exit 4). Spec 0017 §5 mandatory test #33.
   */
  malformedWrapper(): RequestHandler {
    return http.get(`${API_BASE}/all-tasks`, () =>
      HttpResponse.json({ total: 0, count: 0, page: 0, per_page: 25, data: {} }),
    );
  },
};

/**
 * MSW handlers for `freelo tasks show <id>` (R08, spec 0018).
 *
 * Three endpoints:
 *   - `GET /task/{id}` — `TaskDetail` (single object)
 *   - `GET /task/{id}/description` — `TaskComment` (single object, may be empty)
 *   - `GET /task/{id}/subtasks?p=N` — paginated `Subtask[]`
 *
 * The `--with projects` side-car has **no** HTTP endpoint (it's projected
 * from the embedded `TaskDetail.multi_project_task` block — decision 1).
 */
export const tasksShowHandlers = {
  /** `GET /task/{id}` — 200 with the supplied detail body. */
  detailOk(taskId: number, body: Record<string, unknown>): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}`, () => HttpResponse.json(body));
  },

  /** `GET /task/{id}` — 404. */
  detailNotFound(taskId: number): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Task not found.'] }, { status: 404 }),
    );
  },

  /** `GET /task/{id}` — 403. */
  detailForbidden(taskId: number): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  /** `GET /task/{id}` — 401. */
  detailUnauthorized(taskId: number): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `GET /task/{id}` — 5xx. */
  detailServerError(taskId: number, status = 500): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** `GET /task/{id}/description` — 200 with the supplied comment body. */
  descriptionOk(taskId: number, body: Record<string, unknown>): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}/description`, () => HttpResponse.json(body));
  },

  /** `GET /task/{id}/description` — 404. */
  descriptionNotFound(taskId: number): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}/description`, () =>
      HttpResponse.json({ errors: ['Not found.'] }, { status: 404 }),
    );
  },

  /** `GET /task/{id}/description` — 403. */
  descriptionForbidden(taskId: number): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}/description`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  /** `GET /task/{id}/description` — 5xx. */
  descriptionServerError(taskId: number, status = 500): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}/description`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /**
   * `GET /task/{id}/subtasks?p=N` — paginated. `pages` keyed by 0-indexed
   * page number; missing pages return an empty page using the last-known
   * `per_page` and `total`. Same past-end behaviour as
   * `projectShowHandlers.workersPaged`.
   */
  subtasksPaged(taskId: number, pages: Record<number, PagedFixture>): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}/subtasks`, ({ request }) => {
      const u = new URL(request.url);
      const p = Number(u.searchParams.get('p') ?? '0');
      const known = Object.keys(pages)
        .map(Number)
        .sort((a, b) => a - b);
      const lastKnown = known[known.length - 1] ?? 0;
      const fixture = pages[p];
      if (fixture !== undefined) return HttpResponse.json(fixture);
      const ref = pages[lastKnown];
      if (!ref) {
        return HttpResponse.json({
          total: 0,
          count: 0,
          page: p,
          per_page: 25,
          data: { subtasks: [] },
        });
      }
      return HttpResponse.json({
        total: ref.total,
        count: 0,
        page: p,
        per_page: ref.per_page,
        data: { subtasks: [] },
      });
    });
  },

  /** `GET /task/{id}/subtasks` — 404. */
  subtasksNotFound(taskId: number): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}/subtasks`, () =>
      HttpResponse.json({ errors: ['Not found.'] }, { status: 404 }),
    );
  },

  /** `GET /task/{id}/subtasks` — 403. */
  subtasksForbidden(taskId: number): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}/subtasks`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  /** `GET /task/{id}/subtasks` — 5xx for any page. */
  subtasksServerError(taskId: number, status = 500): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}/subtasks`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /**
   * Mid-stream subtasks fetch failure: succeeds for `p < failPage`, errors
   * at `p === failPage`. Drives the `PartialPagesError` unwrap path in the
   * command (mirrors `projectShowHandlers.workersMidStreamError`).
   */
  subtasksMidStreamError(opts: {
    taskId: number;
    pages: Record<number, PagedFixture>;
    failPage: number;
    status?: number;
  }): RequestHandler {
    const { taskId, pages, failPage, status = 500 } = opts;
    return http.get(`${API_BASE}/task/${taskId}/subtasks`, ({ request }) => {
      const u = new URL(request.url);
      const p = Number(u.searchParams.get('p') ?? '0');
      if (p === failPage) {
        return HttpResponse.json({ errors: ['mid-stream'] }, { status });
      }
      const fixture = pages[p];
      if (fixture !== undefined) return HttpResponse.json(fixture);
      return HttpResponse.json({ errors: ['unexpected'] }, { status: 500 });
    });
  },
};

/**
 * MSW handlers for `freelo tasks create` (R09, spec 0019).
 *
 * One endpoint:
 *   - `POST /project/{pid}/tasklist/{tid}/tasks` — `TaskCreated`
 *
 * The startup-time `GET /tasklist/{id}` lookup is served by
 * `tasklistShowHandlers.detailOk` (reused — same endpoint).
 */
export const tasksCreateHandlers = {
  /** `POST /project/{pid}/tasklist/{tid}/tasks` — 200 with the supplied body. */
  ok(
    projectId: number,
    tasklistId: number,
    body: Record<string, unknown>,
    opts?: { onRequest?: (req: Request) => void },
  ): RequestHandler {
    return http.post(
      `${API_BASE}/project/${projectId}/tasklist/${tasklistId}/tasks`,
      ({ request }) => {
        opts?.onRequest?.(request);
        return HttpResponse.json(body);
      },
    );
  },

  /** Same endpoint — 401. */
  unauthorized(projectId: number, tasklistId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/tasklist/${tasklistId}/tasks`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** Same endpoint — 403. */
  forbidden(projectId: number, tasklistId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/tasklist/${tasklistId}/tasks`, () =>
      HttpResponse.json({ errors: ['User has no access to tasklist.'] }, { status: 403 }),
    );
  },

  /** Same endpoint — 404. */
  notFound(projectId: number, tasklistId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/tasklist/${tasklistId}/tasks`, () =>
      HttpResponse.json({ errors: ['Tasklist not found.'] }, { status: 404 }),
    );
  },

  /** Same endpoint — 422 (server-side validation). */
  unprocessable(
    projectId: number,
    tasklistId: number,
    message = 'Server-side validation failed.',
  ): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/tasklist/${tasklistId}/tasks`, () =>
      HttpResponse.json({ errors: [message] }, { status: 422 }),
    );
  },

  /** Same endpoint — 429. */
  rateLimited(projectId: number, tasklistId: number): RequestHandler {
    return http.post(
      `${API_BASE}/project/${projectId}/tasklist/${tasklistId}/tasks`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** Same endpoint — 5xx. */
  serverError(projectId: number, tasklistId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/tasklist/${tasklistId}/tasks`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** Same endpoint — closes the connection (network error). */
  networkError(projectId: number, tasklistId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/tasklist/${tasklistId}/tasks`, () =>
      HttpResponse.error(),
    );
  },

  /**
   * Match-on-body variant: `predicate(body, request)` decides whether the
   * supplied response or a 500 diagnostic comes back. Useful when the test
   * needs to assert the exact wire body.
   */
  okWhenBody(
    projectId: number,
    tasklistId: number,
    predicate: (body: unknown, request: Request) => boolean,
    response: Record<string, unknown>,
  ): RequestHandler {
    return http.post(
      `${API_BASE}/project/${projectId}/tasklist/${tasklistId}/tasks`,
      async ({ request }) => {
        const body: unknown = await request.clone().json();
        if (!predicate(body, request)) {
          return HttpResponse.json(
            { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
            { status: 500 },
          );
        }
        return HttpResponse.json(response);
      },
    );
  },

  /**
   * Sequential responder for batch testing: returns `responses[N]` for the
   * Nth POST (0-indexed). Each entry is `{ status, body }`. Past the end,
   * returns 500.
   */
  sequence(
    projectId: number,
    tasklistId: number,
    responses: Array<{ status: number; body: Record<string, unknown> }>,
  ): RequestHandler {
    const counter = { n: 0 };
    return http.post(`${API_BASE}/project/${projectId}/tasklist/${tasklistId}/tasks`, () => {
      const idx = counter.n;
      counter.n += 1;
      const r = responses[idx] ?? {
        status: 500,
        body: { errors: [`out of sequence (idx=${idx})`] },
      };
      return HttpResponse.json(r.body, { status: r.status });
    });
  },
};

/**
 * MSW handlers for `freelo tasks edit <id>` (R10, spec 0020).
 *
 * Three endpoints:
 *   - `POST /task/{id}` — partial edit (returns `TaskDetail`)
 *   - `POST /task-labels/add-to-task/{id}` — name-mode label add
 *   - `POST /task-labels/remove-from-task/{id}` — name-mode label remove
 *
 * The lookup `GET /task/{id}` and the post-edit refresh `GET /task/{id}` are
 * served by `tasksShowHandlers.detailOk` (reused — same endpoint).
 */
export const tasksEditHandlers = {
  /** `POST /task/{id}` — 200 with the supplied `TaskDetail` body. */
  ok(taskId: number, body: Record<string, unknown>): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}`, () => HttpResponse.json(body));
  },

  /** `POST /task/{id}` — 200, capturing the request body via the predicate. */
  okWhenBody(
    taskId: number,
    predicate: (body: unknown, request: Request) => boolean,
    response: Record<string, unknown>,
  ): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json(response);
    });
  },

  /** `POST /task/{id}` — 401. */
  editUnauthorized(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `POST /task/{id}` — 403. */
  editForbidden(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['User has no access.'] }, { status: 403 }),
    );
  },

  /** `POST /task/{id}` — 422 with a server message. */
  editUnprocessable(taskId: number, message = 'Server-side validation failed.'): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}`, () =>
      HttpResponse.json({ errors: [message] }, { status: 422 }),
    );
  },

  /** `POST /task/{id}` — 429. */
  editRateLimited(taskId: number): RequestHandler {
    return http.post(
      `${API_BASE}/task/${taskId}`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** `POST /task/{id}` — connection-closed (network error). */
  editNetworkError(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}`, () => HttpResponse.error());
  },

  /** `POST /task/{id}` — malformed body (missing required `id`). */
  editMalformed(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}`, () =>
      HttpResponse.json({ name: 'oops, no id' }),
    );
  },

  /** `POST /task-labels/add-to-task/{id}` — 200 success. */
  addLabelsOk(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task-labels/add-to-task/${taskId}`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /** `POST /task-labels/add-to-task/{id}` — 200; predicate inspects the body. */
  addLabelsOkWhenBody(taskId: number, predicate: (body: unknown) => boolean): RequestHandler {
    return http.post(`${API_BASE}/task-labels/add-to-task/${taskId}`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json({ result: 'success' });
    });
  },

  /** `POST /task-labels/add-to-task/{id}` — 422 (e.g. `Unsupported color`). */
  addLabelsUnprocessable(
    taskId: number,
    message = 'Unsupported color (X) provided.',
  ): RequestHandler {
    return http.post(`${API_BASE}/task-labels/add-to-task/${taskId}`, () =>
      HttpResponse.json({ errors: [message] }, { status: 422 }),
    );
  },

  /** `POST /task-labels/remove-from-task/{id}` — 200 success. */
  removeLabelsOk(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task-labels/remove-from-task/${taskId}`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /** `POST /task-labels/remove-from-task/{id}` — 200; predicate inspects the body. */
  removeLabelsOkWhenBody(taskId: number, predicate: (body: unknown) => boolean): RequestHandler {
    return http.post(`${API_BASE}/task-labels/remove-from-task/${taskId}`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json({ result: 'success' });
    });
  },
};

/**
 * MSW handlers for `freelo tasks finish` / `tasks reopen` (R11, spec 0021).
 *
 * Two endpoints:
 *   - `POST /task/{id}/finish`
 *   - `POST /task/{id}/activate`  (CLI verb: `reopen`)
 *
 * Both take an empty body and return `SuccessResponse`. Pre-check GETs are
 * served by `tasksShowHandlers.detailOk(...)` etc. — no new GET handlers
 * needed.
 */
export const tasksTransitionHandlers = {
  /** `POST /task/{id}/finish` — 200 success. */
  finishOk(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/finish`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /** `POST /task/{id}/activate` — 200 success. */
  activateOk(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/activate`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /** `POST /task/{id}/finish` — 401. */
  finishUnauthorized(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/finish`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `POST /task/{id}/finish` — 403. */
  finishForbidden(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/finish`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  /** `POST /task/{id}/finish` — 404. */
  finishNotFound(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/finish`, () =>
      HttpResponse.json({ errors: ['Task not found.'] }, { status: 404 }),
    );
  },

  /** `POST /task/{id}/finish` — 5xx. */
  finishServerError(taskId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/finish`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** `POST /task/{id}/finish` — 429 (Retry-After: 0). */
  finishRateLimited(taskId: number): RequestHandler {
    return http.post(
      `${API_BASE}/task/${taskId}/finish`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** `POST /task/{id}/finish` — connection-closed (network error). */
  finishNetworkError(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/finish`, () => HttpResponse.error());
  },

  /** `POST /task/{id}/activate` — 404 (deleted task per OpenAPI :1802). */
  activateNotFound(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/activate`, () =>
      HttpResponse.json({ errors: ['Task not found.'] }, { status: 404 }),
    );
  },

  /** `POST /task/{id}/activate` — 403. */
  activateForbidden(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/activate`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },
};

/**
 * MSW handlers for `freelo tasks move` (R12, spec 0022).
 *
 * One endpoint:
 *   - `POST /task/{id}/move/{tasklist_id}`
 *
 * Empty body, returns `SuccessResponse`. Pre-check + post-move refresh GETs
 * are served by `tasksShowHandlers.detailOk(...)` etc. — no new GET handlers
 * needed.
 */
export const tasksMoveHandlers = {
  /** `POST /task/{id}/move/{tasklist_id}` — 200 success. */
  moveOk(taskId: number, toTasklistId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/move/${toTasklistId}`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /** `POST /task/{id}/move/{tasklist_id}` — 401. */
  moveUnauthorized(taskId: number, toTasklistId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/move/${toTasklistId}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `POST /task/{id}/move/{tasklist_id}` — 403. */
  moveForbidden(taskId: number, toTasklistId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/move/${toTasklistId}`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  /** `POST /task/{id}/move/{tasklist_id}` — 404 (task or tasklist missing). */
  moveNotFound(taskId: number, toTasklistId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/move/${toTasklistId}`, () =>
      HttpResponse.json({ errors: ['Task or tasklist not found.'] }, { status: 404 }),
    );
  },

  /** `POST /task/{id}/move/{tasklist_id}` — 5xx. */
  moveServerError(taskId: number, toTasklistId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/move/${toTasklistId}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** `POST /task/{id}/move/{tasklist_id}` — 429 (Retry-After: 0). */
  moveRateLimited(taskId: number, toTasklistId: number): RequestHandler {
    return http.post(
      `${API_BASE}/task/${taskId}/move/${toTasklistId}`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** `POST /task/{id}/move/{tasklist_id}` — connection-closed (network error). */
  moveNetworkError(taskId: number, toTasklistId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/move/${toTasklistId}`, () => HttpResponse.error());
  },
};

/**
 * MSW handlers for `freelo tasks delete` (R13, spec 0024).
 *
 * One endpoint:
 *   - `DELETE /task/{task_id}`
 *
 * Empty body, returns `SuccessResponse`. No pre-check GET in R13 v1
 * (spec 0024 decision 4) — the DELETE response is authoritative.
 */
export const tasksDeleteHandlers = {
  /** `DELETE /task/{id}` — 200 success. */
  deleteOk(taskId: number): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /**
   * `DELETE /task/{id}` — 404. The command layer re-classifies this as
   * idempotent already-deleted (spec 0024 decision 3).
   */
  deleteNotFound(taskId: number): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Task not found.'] }, { status: 404 }),
    );
  },

  /** `DELETE /task/{id}` — 401. */
  deleteUnauthorized(taskId: number): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `DELETE /task/{id}` — 403. */
  deleteForbidden(taskId: number): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  /** `DELETE /task/{id}` — 5xx. */
  deleteServerError(taskId: number, status = 500): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** `DELETE /task/{id}` — 429 (Retry-After: 0). */
  deleteRateLimited(taskId: number): RequestHandler {
    return http.delete(
      `${API_BASE}/task/${taskId}`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** `DELETE /task/{id}` — connection-closed (network error). */
  deleteNetworkError(taskId: number): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}`, () => HttpResponse.error());
  },
};

/**
 * MSW handlers for `freelo subtasks add` (R14, spec 0025).
 *
 * One endpoint:
 *   - `POST /task/{task_id}/subtasks` — `Subtask`
 *
 * The `freelo subtasks list` GET path is already served by
 * `tasksShowHandlers.subtasksPaged(...)` etc. — same endpoint as R08.
 * No new GET handlers added here.
 */
export const subtasksAddHandlers = {
  /** `POST /task/{id}/subtasks` — 200 with the supplied response body. */
  ok(taskId: number, body: Record<string, unknown>): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/subtasks`, () => HttpResponse.json(body));
  },

  /**
   * Match-on-body variant: `predicate(body, request)` decides whether the
   * supplied response or a 500 diagnostic comes back. Useful when a test
   * needs to assert the exact wire body.
   */
  okWhenBody(
    taskId: number,
    predicate: (body: unknown, request: Request) => boolean,
    response: Record<string, unknown>,
  ): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/subtasks`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json(response);
    });
  },

  /** `POST /task/{id}/subtasks` — 401. */
  unauthorized(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/subtasks`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `POST /task/{id}/subtasks` — 403. */
  forbidden(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/subtasks`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  /** `POST /task/{id}/subtasks` — 404 (parent task missing). */
  notFound(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/subtasks`, () =>
      HttpResponse.json({ errors: ['Task not found.'] }, { status: 404 }),
    );
  },

  /** `POST /task/{id}/subtasks` — 5xx. */
  serverError(taskId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/subtasks`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** `POST /task/{id}/subtasks` — 429 (Retry-After: 0). */
  rateLimited(taskId: number): RequestHandler {
    return http.post(
      `${API_BASE}/task/${taskId}/subtasks`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** `POST /task/{id}/subtasks` — connection-closed (network error). */
  networkError(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/subtasks`, () => HttpResponse.error());
  },

  /**
   * Sequential responder for batch testing: returns `responses[N]` for the
   * Nth POST (0-indexed). Each entry is `{ status, body }`. Past the end,
   * returns 500. Mirrors `tasksCreateHandlers.sequence`.
   */
  sequence(
    taskId: number,
    responses: Array<{ status: number; body: Record<string, unknown> }>,
  ): RequestHandler {
    const counter = { n: 0 };
    return http.post(`${API_BASE}/task/${taskId}/subtasks`, () => {
      const idx = counter.n;
      counter.n += 1;
      const r = responses[idx] ?? {
        status: 500,
        body: { errors: [`out of sequence (idx=${idx})`] },
      };
      return HttpResponse.json(r.body, { status: r.status });
    });
  },
};

/**
 * MSW handlers for `freelo tasks description set` (R15, spec 0026).
 *
 * One endpoint:
 *   - `POST /task/{task_id}/description` — `Comment`
 *
 * The `freelo tasks description get` GET path is already served by
 * `tasksShowHandlers.descriptionOk(...)` etc. — same endpoint as R08. No
 * new GET handlers added here.
 */
export const tasksDescriptionHandlers = {
  /** `POST /task/{id}/description` — 200 with the supplied response body. */
  setOk(taskId: number, body: Record<string, unknown>): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/description`, () => HttpResponse.json(body));
  },

  /**
   * Match-on-body variant: `predicate(body, request)` decides whether the
   * supplied response or a 500 diagnostic comes back. Useful when a test
   * needs to assert the exact wire body.
   */
  setOkWhenBody(
    taskId: number,
    predicate: (body: unknown, request: Request) => boolean,
    response: Record<string, unknown>,
  ): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/description`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json(response);
    });
  },

  /** `POST /task/{id}/description` — 401. */
  setUnauthorized(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/description`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `POST /task/{id}/description` — 403. */
  setForbidden(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/description`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  /** `POST /task/{id}/description` — 404 (task missing). */
  setNotFound(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/description`, () =>
      HttpResponse.json({ errors: ['Task not found.'] }, { status: 404 }),
    );
  },

  /** `POST /task/{id}/description` — 422 (server-side validation). */
  setUnprocessable(taskId: number, message = 'Server-side validation failed.'): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/description`, () =>
      HttpResponse.json({ errors: [message] }, { status: 422 }),
    );
  },

  /** `POST /task/{id}/description` — 5xx. */
  setServerError(taskId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/description`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** `POST /task/{id}/description` — 429 (Retry-After: 0). */
  setRateLimited(taskId: number): RequestHandler {
    return http.post(
      `${API_BASE}/task/${taskId}/description`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** `POST /task/{id}/description` — connection-closed (network error). */
  setNetworkError(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/description`, () => HttpResponse.error());
  },
};

/**
 * MSW handlers for `freelo comments add` (R17, spec 0028).
 *
 * One endpoint:
 *   - `POST /task/{task_id}/comments` — `Comment` (singleton 200).
 *
 * Mirrors the shape of `tasksDescriptionHandlers` byte-for-byte; only the
 * path and the response shape differ.
 */
export const commentsAddHandlers = {
  /** `POST /task/{id}/comments` — 200 with the supplied response body. */
  addOk(taskId: number, body: Record<string, unknown>): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/comments`, () => HttpResponse.json(body));
  },

  /**
   * 200 with `is_description: true` — simulates the auto-flip to description
   * when the target task has no prior comments (yaml :2589-2592).
   */
  addOkAsDescription(taskId: number, body: Record<string, unknown>): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/comments`, () =>
      HttpResponse.json({ ...body, is_description: true }),
    );
  },

  /**
   * Match-on-body variant: `predicate(body, request)` decides whether the
   * supplied response or a 500 diagnostic comes back. Useful when a test
   * needs to assert the exact wire body.
   */
  addOkWhenBody(
    taskId: number,
    predicate: (body: unknown, request: Request) => boolean,
    response: Record<string, unknown>,
  ): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/comments`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json(response);
    });
  },

  /** `POST /task/{id}/comments` — 401. */
  addUnauthorized(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/comments`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `POST /task/{id}/comments` — 403. */
  addForbidden(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/comments`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  /** `POST /task/{id}/comments` — 404 (task missing). */
  addNotFound(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/comments`, () =>
      HttpResponse.json({ errors: ['Task not found.'] }, { status: 404 }),
    );
  },

  /** `POST /task/{id}/comments` — 422 (server-side validation). */
  addUnprocessable(taskId: number, message = 'Server-side validation failed.'): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/comments`, () =>
      HttpResponse.json({ errors: [message] }, { status: 422 }),
    );
  },

  /** `POST /task/{id}/comments` — 5xx. */
  addServerError(taskId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/comments`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** `POST /task/{id}/comments` — 429 (Retry-After: 0). */
  addRateLimited(taskId: number): RequestHandler {
    return http.post(
      `${API_BASE}/task/${taskId}/comments`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** `POST /task/{id}/comments` — connection-closed (network error). */
  addNetworkError(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/comments`, () => HttpResponse.error());
  },
};

/**
 * MSW handlers for `freelo comments edit` (R18, spec 0029).
 *
 * One endpoint:
 *   - `POST /comment/{comment_id}` — `Comment` (singleton 200).
 *
 * Mirrors `commentsAddHandlers` byte-for-byte; only the path differs.
 */
export const commentsEditHandlers = {
  /** `POST /comment/{id}` — 200 with the supplied response body. */
  editOk(commentId: number, body: Record<string, unknown>): RequestHandler {
    return http.post(`${API_BASE}/comment/${commentId}`, () => HttpResponse.json(body));
  },

  /**
   * Match-on-body variant: `predicate(body, request)` decides whether the
   * supplied response or a 500 diagnostic comes back. Useful when a test
   * needs to assert the exact wire body.
   */
  editOkWhenBody(
    commentId: number,
    predicate: (body: unknown, request: Request) => boolean,
    response: Record<string, unknown>,
  ): RequestHandler {
    return http.post(`${API_BASE}/comment/${commentId}`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json(response);
    });
  },

  /** `POST /comment/{id}` — 401. */
  editUnauthorized(commentId: number): RequestHandler {
    return http.post(`${API_BASE}/comment/${commentId}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `POST /comment/{id}` — 403 (defensive; yaml says 404 on ACL). */
  editForbidden(commentId: number): RequestHandler {
    return http.post(`${API_BASE}/comment/${commentId}`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  /** `POST /comment/{id}` — 404 (comment missing or ACL violation per yaml :2633). */
  editNotFound(commentId: number): RequestHandler {
    return http.post(`${API_BASE}/comment/${commentId}`, () =>
      HttpResponse.json({ errors: ['Comment not found.'] }, { status: 404 }),
    );
  },

  /** `POST /comment/{id}` — 422 (server-side validation). */
  editUnprocessable(commentId: number, message = 'Server-side validation failed.'): RequestHandler {
    return http.post(`${API_BASE}/comment/${commentId}`, () =>
      HttpResponse.json({ errors: [message] }, { status: 422 }),
    );
  },

  /** `POST /comment/{id}` — 5xx. */
  editServerError(commentId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/comment/${commentId}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** `POST /comment/{id}` — 429 (Retry-After: 0). */
  editRateLimited(commentId: number): RequestHandler {
    return http.post(
      `${API_BASE}/comment/${commentId}`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** `POST /comment/{id}` — connection-closed (network error). */
  editNetworkError(commentId: number): RequestHandler {
    return http.post(`${API_BASE}/comment/${commentId}`, () => HttpResponse.error());
  },
};

/**
 * MSW handlers for `freelo comments list` (R16, spec 0027).
 *
 * One endpoint:
 *   - `GET /all-comments` — `PaginatedResponse` of `CommentFull[]`
 *
 * The query parameters are exposed via the `request` callback so tests can
 * assert wire shape (`projects_ids[]=...`, `type=...`, `order_by=...`,
 * `order=...`, `p=...`).
 */
export const commentsListHandlers = {
  /**
   * `GET /all-comments?p=N` — paginated. `pages` keyed by 0-indexed page
   * number; missing pages return an empty page using the last-known
   * `per_page` and `total`. Same past-end behaviour as
   * `tasksShowHandlers.subtasksPaged`.
   */
  paged(
    pages: Record<number, PagedFixture>,
    opts?: { onRequest?: (req: Request) => void },
  ): RequestHandler {
    return http.get(`${API_BASE}/all-comments`, ({ request }) => {
      opts?.onRequest?.(request);
      const u = new URL(request.url);
      const p = Number(u.searchParams.get('p') ?? '0');
      const known = Object.keys(pages)
        .map(Number)
        .sort((a, b) => a - b);
      const lastKnown = known[known.length - 1] ?? 0;
      const fixture = pages[p];
      if (fixture !== undefined) return HttpResponse.json(fixture);
      const ref = pages[lastKnown];
      if (!ref) {
        return HttpResponse.json({
          total: 0,
          count: 0,
          page: p,
          per_page: 25,
          data: { comments: [] },
        });
      }
      return HttpResponse.json({
        total: ref.total,
        count: 0,
        page: p,
        per_page: ref.per_page,
        data: { comments: [] },
      });
    });
  },

  /** `GET /all-comments` — 401. */
  unauthorized(): RequestHandler {
    return http.get(`${API_BASE}/all-comments`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `GET /all-comments` — 403. */
  forbidden(): RequestHandler {
    return http.get(`${API_BASE}/all-comments`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  /** `GET /all-comments` — 404. */
  notFound(): RequestHandler {
    return http.get(`${API_BASE}/all-comments`, () =>
      HttpResponse.json({ errors: ['Not found.'] }, { status: 404 }),
    );
  },

  /** `GET /all-comments` — 5xx for any page. */
  serverError(status = 500): RequestHandler {
    return http.get(`${API_BASE}/all-comments`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** `GET /all-comments` — 429 (Retry-After: 0 so retry exhaustion is fast). */
  rateLimited(): RequestHandler {
    return http.get(
      `${API_BASE}/all-comments`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** `GET /all-comments` — connection-closed (network error). */
  networkError(): RequestHandler {
    return http.get(`${API_BASE}/all-comments`, () => HttpResponse.error());
  },

  /**
   * Mid-stream fetch failure: succeeds for `p < failPage`, errors at
   * `p === failPage`. Drives the `PartialPagesError` unwrap path in the
   * command.
   */
  midStreamError(opts: {
    pages: Record<number, PagedFixture>;
    failPage: number;
    status?: number;
  }): RequestHandler {
    const { pages, failPage, status = 500 } = opts;
    return http.get(`${API_BASE}/all-comments`, ({ request }) => {
      const u = new URL(request.url);
      const p = Number(u.searchParams.get('p') ?? '0');
      if (p === failPage) {
        return HttpResponse.json({ errors: ['mid-stream'] }, { status });
      }
      const fixture = pages[p];
      if (fixture !== undefined) return HttpResponse.json(fixture);
      return HttpResponse.json({ errors: ['unexpected'] }, { status: 500 });
    });
  },
};

/**
 * MSW handlers for `freelo time start` / `time status` (R19, spec 0030).
 *
 * Two endpoints:
 *   - `POST /timetracking/start` — singleton 200 `{ uuid }`, 409 on conflict.
 *   - `GET  /timetracking/status` — 200 active session JSON, **204 No Content**
 *     when no session is active.
 *
 * Singleton-409 is the load-bearing case (spec 0030 §2.4); 204 is the
 * load-bearing read case (spec 0030 §2.5).
 */
export const timeHandlers = {
  /** `POST /timetracking/start` — 200 with `{ uuid }`. */
  startOk(uuid = 'tt-uuid-12345'): RequestHandler {
    return http.post(`${API_BASE}/timetracking/start`, () => HttpResponse.json({ uuid }));
  },

  /**
   * Match-on-body variant — captures the request body. Returns 200 `{ uuid }`
   * when the predicate accepts the body; 500 otherwise (so a mismatch shows
   * up clearly in test output).
   */
  startOkWhenBody(
    predicate: (body: unknown, request: Request) => boolean,
    uuid = 'tt-uuid-12345',
  ): RequestHandler {
    return http.post(`${API_BASE}/timetracking/start`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json({ uuid });
    });
  },

  /** `POST /timetracking/start` — 409 (singleton already running). */
  startConflict(): RequestHandler {
    return http.post(`${API_BASE}/timetracking/start`, () =>
      HttpResponse.json({ errors: ['Timetracking is already running.'] }, { status: 409 }),
    );
  },

  /** `POST /timetracking/start` — 401. */
  startUnauthorized(): RequestHandler {
    return http.post(`${API_BASE}/timetracking/start`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `POST /timetracking/start` — 404 (task not found). */
  startNotFound(): RequestHandler {
    return http.post(`${API_BASE}/timetracking/start`, () =>
      HttpResponse.json({ errors: ['Task not found.'] }, { status: 404 }),
    );
  },

  /** `POST /timetracking/start` — 5xx. */
  startServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/timetracking/start`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** `GET /timetracking/status` — 200 active session with the supplied body. */
  statusActive(body: Record<string, unknown>): RequestHandler {
    return http.get(`${API_BASE}/timetracking/status`, () => HttpResponse.json(body));
  },

  /** `GET /timetracking/status` — **204 No Content** (no active timer). */
  statusInactive(): RequestHandler {
    return http.get(
      `${API_BASE}/timetracking/status`,
      () => new HttpResponse(null, { status: 204 }),
    );
  },

  /** `GET /timetracking/status` — 401. */
  statusUnauthorized(): RequestHandler {
    return http.get(`${API_BASE}/timetracking/status`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `GET /timetracking/status` — 5xx. */
  statusServerError(status = 500): RequestHandler {
    return http.get(`${API_BASE}/timetracking/status`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },
};

/**
 * Pre-configured MSW server. Start in tests with:
 *
 *   beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
 *   afterEach(() => server.resetHandlers());
 *   afterAll(() => server.close());
 */
export const server = setupServer();
