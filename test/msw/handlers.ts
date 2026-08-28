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

  /** `POST /task-labels/add-to-task/{id}` — 5xx (spec 0041 partial-failure path). */
  addLabelsServerError(taskId: number, status = 502): RequestHandler {
    return http.post(`${API_BASE}/task-labels/add-to-task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Bad gateway.'] }, { status }),
    );
  },

  /** `POST /task-labels/add-to-task/{id}` — connection-closed (spec 0041 partial-failure path). */
  addLabelsNetworkError(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task-labels/add-to-task/${taskId}`, () => HttpResponse.error());
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
 * MSW handlers for `freelo reports list` (R21, spec 0033).
 *
 * One endpoint:
 *   - `GET /work-reports` — `PaginatedResponse` of `WorkReportFull[]`
 *
 * The query parameters are exposed via the optional `onRequest` callback so
 * tests can assert wire shape (`tasks_ids[]=...`, `projects_ids[]=...`,
 * `users_ids[]=...`, `date_reported_range[date_from]=...`, `p=...`).
 *
 * Mirrors `commentsListHandlers` byte-for-byte modulo URL and inner key.
 */
export const workReportsListHandlers = {
  /**
   * `GET /work-reports?p=N` — paginated. `pages` keyed by 0-indexed page
   * number; missing pages return an empty page using the last-known
   * `per_page` and `total`. Same past-end behaviour as
   * `commentsListHandlers.paged`.
   */
  paged(
    pages: Record<number, PagedFixture>,
    opts?: { onRequest?: (req: Request) => void },
  ): RequestHandler {
    return http.get(`${API_BASE}/work-reports`, ({ request }) => {
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
          data: { reports: [] },
        });
      }
      return HttpResponse.json({
        total: ref.total,
        count: 0,
        page: p,
        per_page: ref.per_page,
        data: { reports: [] },
      });
    });
  },

  /** `GET /work-reports` — 401. */
  unauthorized(): RequestHandler {
    return http.get(`${API_BASE}/work-reports`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `GET /work-reports` — 403. */
  forbidden(): RequestHandler {
    return http.get(`${API_BASE}/work-reports`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  /** `GET /work-reports` — 404. */
  notFound(): RequestHandler {
    return http.get(`${API_BASE}/work-reports`, () =>
      HttpResponse.json({ errors: ['Not found.'] }, { status: 404 }),
    );
  },

  /** `GET /work-reports` — 5xx for any page. */
  serverError(status = 500): RequestHandler {
    return http.get(`${API_BASE}/work-reports`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** `GET /work-reports` — 429 (Retry-After: 0 so retry exhaustion is fast). */
  rateLimited(): RequestHandler {
    return http.get(
      `${API_BASE}/work-reports`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** `GET /work-reports` — connection-closed (network error). */
  networkError(): RequestHandler {
    return http.get(`${API_BASE}/work-reports`, () => HttpResponse.error());
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
    return http.get(`${API_BASE}/work-reports`, ({ request }) => {
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
   * Malformed 200 — the response body has the right wrapper but a `reports[0]`
   * with the wrong types. Drives the schema-validation error path
   * (`FreeloApiError` with `code: 'VALIDATION_ERROR'`).
   */
  malformed(): RequestHandler {
    return http.get(`${API_BASE}/work-reports`, () =>
      HttpResponse.json({
        total: 1,
        count: 1,
        page: 0,
        per_page: 25,
        data: { reports: [{ id: 'not-a-number', date_reported: '2026-04-25', minutes: 30 }] },
      }),
    );
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

  /* -------------------------------------------------------------------------
   *  R20 — `POST /timetracking/stop` / `POST /timetracking/edit` (spec 0032)
   * ----------------------------------------------------------------------- */

  /** `POST /timetracking/stop` — 200 with the supplied WorkReport body. */
  stopOk(workReport: Record<string, unknown>): RequestHandler {
    return http.post(`${API_BASE}/timetracking/stop`, () => HttpResponse.json(workReport));
  },

  /** `POST /timetracking/stop` — 409 (no active session). */
  stopConflict(): RequestHandler {
    return http.post(`${API_BASE}/timetracking/stop`, () =>
      HttpResponse.json({ errors: ['Timetracking is not running.'] }, { status: 409 }),
    );
  },

  /** `POST /timetracking/stop` — 401. */
  stopUnauthorized(): RequestHandler {
    return http.post(`${API_BASE}/timetracking/stop`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `POST /timetracking/stop` — 5xx. */
  stopServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/timetracking/stop`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** `POST /timetracking/edit` — 200 with `{ uuid }`. */
  editTimerOk(uuid = 'tt-uuid-edit-12345'): RequestHandler {
    return http.post(`${API_BASE}/timetracking/edit`, () => HttpResponse.json({ uuid }));
  },

  /**
   * Match-on-body variant — captures the request body. Returns 200 `{ uuid }`
   * when the predicate accepts the body; 500 otherwise so a mismatch is
   * loud in test output.
   */
  editTimerOkWhenBody(
    predicate: (body: unknown, request: Request) => boolean,
    uuid = 'tt-uuid-edit-12345',
  ): RequestHandler {
    return http.post(`${API_BASE}/timetracking/edit`, async ({ request }) => {
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

  /** `POST /timetracking/edit` — 409 (no active session). */
  editTimerConflict(): RequestHandler {
    return http.post(`${API_BASE}/timetracking/edit`, () =>
      HttpResponse.json({ errors: ['Timetracking is not running.'] }, { status: 409 }),
    );
  },

  /** `POST /timetracking/edit` — 401. */
  editTimerUnauthorized(): RequestHandler {
    return http.post(`${API_BASE}/timetracking/edit`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `POST /timetracking/edit` — 5xx. */
  editTimerServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/timetracking/edit`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },
};

/**
 * MSW handlers for `freelo reports log` / `reports edit` / `reports delete`
 * (R22, spec 0034).
 *
 * Three endpoints:
 *   - `POST   /task/{taskId}/work-reports`  — log a new work report.
 *   - `POST   /work-reports/{id}`           — edit an existing report.
 *   - `DELETE /work-reports/{id}`           — delete a report.
 *
 * The match-on-body variants expose the captured wire body via the optional
 * predicate argument so tests can assert exact `minutes` / `note` /
 * `date_reported` round-trip.
 *
 * Mirrors `timeHandlers` byte-for-byte modulo URL/verb.
 */
export const workReportsWriteHandlers = {
  /* ---------------------------------------------------------------------
   *  POST /task/{taskId}/work-reports
   * ------------------------------------------------------------------- */

  /** 200 with the supplied WorkReport body. Path matches any `taskId`. */
  createOk(report: Record<string, unknown>): RequestHandler {
    return http.post(`${API_BASE}/task/:taskId/work-reports`, () => HttpResponse.json(report));
  },

  /**
   * Match-on-body variant — the predicate sees the parsed body and the raw
   * request (so tests can also assert path → taskId). Returns 200 when the
   * predicate accepts; 500 otherwise.
   */
  createOkWhenBody(
    predicate: (body: unknown, request: Request) => boolean,
    report: Record<string, unknown>,
  ): RequestHandler {
    return http.post(`${API_BASE}/task/:taskId/work-reports`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json(report);
    });
  },

  /** 400 with a custom message (e.g. `WorkReportCanNotBeCreatedException`). */
  createBadRequest(message = 'WorkReportCanNotBeCreatedException'): RequestHandler {
    return http.post(`${API_BASE}/task/:taskId/work-reports`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  /** 401. */
  createUnauthorized(): RequestHandler {
    return http.post(`${API_BASE}/task/:taskId/work-reports`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** 5xx. */
  createServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/task/:taskId/work-reports`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** 429 with `Retry-After: 0` so retry exhaustion is fast in tests. */
  createRateLimited(): RequestHandler {
    return http.post(
      `${API_BASE}/task/:taskId/work-reports`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** Connection-closed (network error). */
  createNetworkError(): RequestHandler {
    return http.post(`${API_BASE}/task/:taskId/work-reports`, () => HttpResponse.error());
  },

  /** 200 with a malformed body to drive the schema-validation error path. */
  createMalformed(): RequestHandler {
    return http.post(`${API_BASE}/task/:taskId/work-reports`, () =>
      HttpResponse.json({ id: 'not-a-number', minutes: 30, date_reported: '2026-04-25' }),
    );
  },

  /* ---------------------------------------------------------------------
   *  POST /work-reports/{id}
   * ------------------------------------------------------------------- */

  /** 200 with the supplied WorkReport body. Path matches any `id`. */
  editOk(report: Record<string, unknown>): RequestHandler {
    return http.post(`${API_BASE}/work-reports/:id`, () => HttpResponse.json(report));
  },

  editOkWhenBody(
    predicate: (body: unknown, request: Request) => boolean,
    report: Record<string, unknown>,
  ): RequestHandler {
    return http.post(`${API_BASE}/work-reports/:id`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json(report);
    });
  },

  /** 404 (NotFoundException — used both for genuine missing and ACL-as-404). */
  editNotFound(): RequestHandler {
    return http.post(`${API_BASE}/work-reports/:id`, () =>
      HttpResponse.json({ errors: ['NotFoundException'] }, { status: 404 }),
    );
  },

  editUnauthorized(): RequestHandler {
    return http.post(`${API_BASE}/work-reports/:id`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  editServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/work-reports/:id`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /* ---------------------------------------------------------------------
   *  DELETE /work-reports/{id}  (four-arm idempotency matrix)
   * ------------------------------------------------------------------- */

  /** Live success: 200 `{ result: 'success' }`. */
  deleteOk(): RequestHandler {
    return http.delete(`${API_BASE}/work-reports/:id`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /**
   * Idempotency arm 1 — 404. The leaf re-classifies as
   * `already_in_target_state: true`.
   */
  deleteNotFound(): RequestHandler {
    return http.delete(`${API_BASE}/work-reports/:id`, () =>
      HttpResponse.json({ errors: ['Not found.'] }, { status: 404 }),
    );
  },

  /**
   * Idempotency arm 2 — 400 with a body text that matches "not found"
   * or "does not exist". The leaf re-classifies as idempotent skip.
   *
   * Default message uses both phrases to exercise the regex in either order.
   */
  deleteBadRequestNotFound(message = 'Work report does not exist.'): RequestHandler {
    return http.delete(`${API_BASE}/work-reports/:id`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  /**
   * Idempotency arm 3 — 400 with `UserCannotDeleteWorkReport` ACL marker.
   * The leaf surfaces this as a hard `FreeloApiError`.
   */
  deleteBadRequestAcl(): RequestHandler {
    return http.delete(`${API_BASE}/work-reports/:id`, () =>
      HttpResponse.json(
        { errors: ['UserCannotDeleteWorkReport: caller is not the report author.'] },
        { status: 400 },
      ),
    );
  },

  /**
   * Idempotency arm 4 — 400 without either marker. The leaf bubbles as a
   * hard error. Edge case used to prove the catch falls through.
   */
  deleteBadRequestOther(): RequestHandler {
    return http.delete(`${API_BASE}/work-reports/:id`, () =>
      HttpResponse.json(
        { errors: ['Some other 400 reason that the heuristic should NOT eat.'] },
        { status: 400 },
      ),
    );
  },

  deleteUnauthorized(): RequestHandler {
    return http.delete(`${API_BASE}/work-reports/:id`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  deleteServerError(status = 500): RequestHandler {
    return http.delete(`${API_BASE}/work-reports/:id`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  deleteRateLimited(): RequestHandler {
    return http.delete(
      `${API_BASE}/work-reports/:id`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /**
   * Sequential per-id responder — used by tests that want different
   * responses per id (e.g. delete two reports, second is already-deleted).
   * The router maps the captured `:id` to the supplied per-id handler.
   *
   * Unmatched ids return a generic 200 success (deletion succeeded).
   */
  perIdRouter(routes: Record<string, () => Response | HttpResponse>): RequestHandler {
    return http.delete(`${API_BASE}/work-reports/:id`, ({ params }) => {
      const idStr = String(params['id']);
      const route = routes[idStr];
      if (route) return route();
      return HttpResponse.json({ result: 'success' });
    });
  },
};

/**
 * MSW handlers for `freelo labels list / rename / delete / attach / detach`
 * (R23, spec 0035).
 *
 * Endpoints:
 *   - `GET    /project-labels/find-available`              — list (no params)
 *   - `POST   /project-labels/{labelId}`                   — rename / recolor
 *   - `DELETE /project-labels/{labelId}`                   — global hard-delete
 *   - `POST   /project-labels/add-to-project/{projectId}`  — attach (data-mode)
 *   - `POST   /project-labels/remove-from-project/{projectId}` — detach (id-mode)
 *
 * Verbs reconciled per spec decisions 01 (rename POST) and 02 (detach POST).
 *
 * Mirrors the `workReportsWriteHandlers` shape modulo URL/verb.
 */
export const projectLabelsHandlers = {
  /* ---------------------------------------------------------------------
   *  GET /project-labels/find-available
   * ------------------------------------------------------------------- */

  /**
   * 200 with a `{ labels: ProjectLabel[] }` body.
   *
   * The OpenAPI spec documents the key as `label` (singular) but the
   * live API returns `labels` (plural). Schema and handler follow
   * reality, not the spec. See src/api/schemas/project-label.ts.
   */
  findAvailableOk(labels: Record<string, unknown>[]): RequestHandler {
    return http.get(`${API_BASE}/project-labels/find-available`, () =>
      HttpResponse.json({ labels }),
    );
  },

  /** 200 with malformed body — `labels` missing → schema validation fails. */
  findAvailableMalformed(): RequestHandler {
    return http.get(`${API_BASE}/project-labels/find-available`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  findAvailableUnauthorized(): RequestHandler {
    return http.get(`${API_BASE}/project-labels/find-available`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  findAvailableServerError(status = 500): RequestHandler {
    return http.get(`${API_BASE}/project-labels/find-available`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  findAvailableRateLimited(): RequestHandler {
    return http.get(
      `${API_BASE}/project-labels/find-available`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  findAvailableNetworkError(): RequestHandler {
    return http.get(`${API_BASE}/project-labels/find-available`, () => HttpResponse.error());
  },

  /* ---------------------------------------------------------------------
   *  POST /project-labels/{labelId}  (rename / recolor / toggle)
   * ------------------------------------------------------------------- */

  /** 200 success on the rename endpoint. */
  editOk(): RequestHandler {
    return http.post(`${API_BASE}/project-labels/:labelId`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /** Match-on-body variant. Predicate sees the parsed JSON body. */
  editOkWhenBody(predicate: (body: unknown, request: Request) => boolean): RequestHandler {
    return http.post(`${API_BASE}/project-labels/:labelId`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json({ result: 'success' });
    });
  },

  editForbidden(): RequestHandler {
    return http.post(`${API_BASE}/project-labels/:labelId`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  editNotFound(): RequestHandler {
    return http.post(`${API_BASE}/project-labels/:labelId`, () =>
      HttpResponse.json({ errors: ['NotFoundException'] }, { status: 404 }),
    );
  },

  editUnauthorized(): RequestHandler {
    return http.post(`${API_BASE}/project-labels/:labelId`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  editServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/project-labels/:labelId`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  editRateLimited(): RequestHandler {
    return http.post(
      `${API_BASE}/project-labels/:labelId`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /* ---------------------------------------------------------------------
   *  DELETE /project-labels/{labelId}  (global hard-delete; idempotent 404)
   * ------------------------------------------------------------------- */

  deleteOk(): RequestHandler {
    return http.delete(`${API_BASE}/project-labels/:labelId`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /** Idempotency arm — 404 → CLI re-classifies as already_in_target_state: true. */
  deleteNotFound(): RequestHandler {
    return http.delete(`${API_BASE}/project-labels/:labelId`, () =>
      HttpResponse.json({ errors: ['Not found.'] }, { status: 404 }),
    );
  },

  deleteForbidden(): RequestHandler {
    return http.delete(`${API_BASE}/project-labels/:labelId`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  deleteUnauthorized(): RequestHandler {
    return http.delete(`${API_BASE}/project-labels/:labelId`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  deleteServerError(status = 500): RequestHandler {
    return http.delete(`${API_BASE}/project-labels/:labelId`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  deleteRateLimited(): RequestHandler {
    return http.delete(
      `${API_BASE}/project-labels/:labelId`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** Per-id router for delete — different responses per id. */
  deletePerIdRouter(routes: Record<string, () => Response | HttpResponse>): RequestHandler {
    return http.delete(`${API_BASE}/project-labels/:labelId`, ({ params }) => {
      const idStr = String(params['labelId']);
      const route = routes[idStr];
      if (route) return route();
      return HttpResponse.json({ result: 'success' });
    });
  },

  /* ---------------------------------------------------------------------
   *  POST /project-labels/add-to-project/{projectId}  (attach, data-mode)
   * ------------------------------------------------------------------- */

  attachOk(): RequestHandler {
    return http.post(`${API_BASE}/project-labels/add-to-project/:projectId`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  attachOkWhenBody(predicate: (body: unknown, request: Request) => boolean): RequestHandler {
    return http.post(
      `${API_BASE}/project-labels/add-to-project/:projectId`,
      async ({ request }) => {
        const body: unknown = await request.clone().json();
        if (!predicate(body, request)) {
          return HttpResponse.json(
            { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
            { status: 500 },
          );
        }
        return HttpResponse.json({ result: 'success' });
      },
    );
  },

  attachForbidden(): RequestHandler {
    return http.post(`${API_BASE}/project-labels/add-to-project/:projectId`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  /** Project gone — NOT idempotent (decision per spec error matrix). */
  attachNotFound(): RequestHandler {
    return http.post(`${API_BASE}/project-labels/add-to-project/:projectId`, () =>
      HttpResponse.json({ errors: ['Project not found.'] }, { status: 404 }),
    );
  },

  attachServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/project-labels/add-to-project/:projectId`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** Per-name router — used by tests that want different responses per body name. */
  attachPerNameRouter(routes: Record<string, () => Response | HttpResponse>): RequestHandler {
    return http.post(
      `${API_BASE}/project-labels/add-to-project/:projectId`,
      async ({ request }) => {
        const body = (await request.clone().json()) as { name?: string };
        const name = body.name ?? '';
        const route = routes[name];
        if (route) return route();
        return HttpResponse.json({ result: 'success' });
      },
    );
  },

  /* ---------------------------------------------------------------------
   *  POST /project-labels/remove-from-project/{projectId}  (detach, id-mode)
   * ------------------------------------------------------------------- */

  detachOk(): RequestHandler {
    return http.post(`${API_BASE}/project-labels/remove-from-project/:projectId`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  detachOkWhenBody(predicate: (body: unknown, request: Request) => boolean): RequestHandler {
    return http.post(
      `${API_BASE}/project-labels/remove-from-project/:projectId`,
      async ({ request }) => {
        const body: unknown = await request.clone().json();
        if (!predicate(body, request)) {
          return HttpResponse.json(
            { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
            { status: 500 },
          );
        }
        return HttpResponse.json({ result: 'success' });
      },
    );
  },

  /** Idempotency arm — 404 → already_in_target_state: true (decision 09). */
  detachNotFound(): RequestHandler {
    return http.post(`${API_BASE}/project-labels/remove-from-project/:projectId`, () =>
      HttpResponse.json({ errors: ['Label not attached to project.'] }, { status: 404 }),
    );
  },

  detachServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/project-labels/remove-from-project/:projectId`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** Per-id router — different response per body.id. */
  detachPerIdRouter(routes: Record<string, () => Response | HttpResponse>): RequestHandler {
    return http.post(
      `${API_BASE}/project-labels/remove-from-project/:projectId`,
      async ({ request }) => {
        const body = (await request.clone().json()) as { id?: number };
        const idStr = String(body.id ?? '');
        const route = routes[idStr];
        if (route) return route();
        return HttpResponse.json({ result: 'success' });
      },
    );
  },
};

/**
 * MSW handler factories for `task-labels` endpoints (R24, spec 0036).
 *
 *   POST /task-labels                                  — bulk-create
 *   POST /task-labels/add-to-task/{task_id}            — attach
 *   POST /task-labels/remove-from-task/{task_id}       — detach
 *
 * Note: detach is POST per OpenAPI (decision 01), not DELETE.
 */
export const taskLabelsHandlers = {
  /* ---------------------------------------------------------------------
   *  POST /task-labels — bulk-create
   * ------------------------------------------------------------------- */

  createOk(): RequestHandler {
    return http.post(`${API_BASE}/task-labels`, () => HttpResponse.json({ result: 'success' }));
  },

  createOkWhenBody(predicate: (body: unknown, request: Request) => boolean): RequestHandler {
    return http.post(`${API_BASE}/task-labels`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json({ result: 'success' });
    });
  },

  createServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/task-labels`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /* ---------------------------------------------------------------------
   *  POST /task-labels/add-to-task/{task_id} — attach
   * ------------------------------------------------------------------- */

  attachOk(): RequestHandler {
    return http.post(`${API_BASE}/task-labels/add-to-task/:taskId`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  attachOkWhenBody(predicate: (body: unknown, request: Request) => boolean): RequestHandler {
    return http.post(`${API_BASE}/task-labels/add-to-task/:taskId`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json({ result: 'success' });
    });
  },

  attachBadRequest(message = 'Unsupported color (#zzzzzz) provided.'): RequestHandler {
    return http.post(`${API_BASE}/task-labels/add-to-task/:taskId`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  attachServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/task-labels/add-to-task/:taskId`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /* ---------------------------------------------------------------------
   *  POST /task-labels/remove-from-task/{task_id} — detach
   * ------------------------------------------------------------------- */

  detachOk(): RequestHandler {
    return http.post(`${API_BASE}/task-labels/remove-from-task/:taskId`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  detachOkWhenBody(predicate: (body: unknown, request: Request) => boolean): RequestHandler {
    return http.post(`${API_BASE}/task-labels/remove-from-task/:taskId`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json({ result: 'success' });
    });
  },

  detachServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/task-labels/remove-from-task/:taskId`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /* ---------------------------------------------------------------------
   *  GET /task-labels/find-available — list (M04, spec 0062)
   *
   *  Distinct endpoint from `GET /project-labels/find-available`, which is
   *  served by `projectLabelsHandlers.findAvailable*` above. Different
   *  resource group, uuid-keyed items, accepts `?project_id=`.
   * ------------------------------------------------------------------- */

  /** 200 with a `{ labels: TaskLabel[] }` body. */
  findOk(labels: Record<string, unknown>[]): RequestHandler {
    return http.get(`${API_BASE}/task-labels/find-available`, () => HttpResponse.json({ labels }));
  },

  /**
   * 200, and records the full request URL into `capture` so the test can
   * assert on the query string (presence/absence of `project_id`).
   */
  findOkCapturing(capture: string[], labels: Record<string, unknown>[] = []): RequestHandler {
    return http.get(`${API_BASE}/task-labels/find-available`, ({ request }) => {
      capture.push(request.url);
      return HttpResponse.json({ labels });
    });
  },

  /** 200 with malformed body — `labels` key missing → schema validation fails. */
  findMalformed(): RequestHandler {
    return http.get(`${API_BASE}/task-labels/find-available`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  findUnauthorized(): RequestHandler {
    return http.get(`${API_BASE}/task-labels/find-available`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  findServerError(status = 500): RequestHandler {
    return http.get(`${API_BASE}/task-labels/find-available`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  findRateLimited(): RequestHandler {
    return http.get(
      `${API_BASE}/task-labels/find-available`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  findNetworkError(): RequestHandler {
    return http.get(`${API_BASE}/task-labels/find-available`, () => HttpResponse.error());
  },
};

/**
 * MSW handlers for `POST /file/upload` (R25, spec 0037).
 *
 * The Freelo upload endpoint accepts `multipart/form-data` with a single
 * `file` field. Real responses return `{ uuid }`. The predicate variants
 * verify the multipart body shape (presence of the `file` form part).
 */
export const filesUploadHandlers = {
  /** 200 with a fixed UUID (or a custom one). */
  uploadOk(uuid = '11111111-1111-1111-1111-111111111111'): RequestHandler {
    return http.post(`${API_BASE}/file/upload`, () => HttpResponse.json({ uuid }));
  },

  /** 200 only when the predicate matches the parsed multipart FormData. */
  uploadOkWhenMultipart(
    predicate: (form: FormData, request: Request) => boolean,
    uuid = '11111111-1111-1111-1111-111111111111',
  ): RequestHandler {
    return http.post(`${API_BASE}/file/upload`, async ({ request }) => {
      const form = await request.clone().formData();
      if (!predicate(form, request)) {
        return HttpResponse.json(
          { errors: [`Multipart body did not match predicate.`] },
          { status: 500 },
        );
      }
      return HttpResponse.json({ uuid });
    });
  },

  /**
   * Sequential multi-call handler — returns a different uuid for each
   * incoming POST in the order provided. Internal counter is fresh per
   * factory invocation (handlers are reset between tests via
   * `server.resetHandlers()`).
   */
  uploadOkSequential(uuids: readonly string[]): RequestHandler {
    let idx = 0;
    return http.post(`${API_BASE}/file/upload`, () => {
      const uuid = uuids[idx] ?? uuids[uuids.length - 1] ?? 'fallback-uuid';
      idx += 1;
      return HttpResponse.json({ uuid });
    });
  },

  /** 400 oversize / forbidden type. */
  uploadBadRequest(message = 'File too large.'): RequestHandler {
    return http.post(`${API_BASE}/file/upload`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  /** 401 — auth expired. */
  uploadAuthExpired(): RequestHandler {
    return http.post(`${API_BASE}/file/upload`, () =>
      HttpResponse.json({ errors: [{ message: 'Invalid token' }] }, { status: 401 }),
    );
  },

  /** 5xx server error. */
  uploadServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/file/upload`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** Malformed 200 — missing uuid field. */
  uploadMalformed(): RequestHandler {
    return http.post(`${API_BASE}/file/upload`, () => HttpResponse.json({ result: 'success' }));
  },
};

/**
 * MSW handlers for `GET /all-docs-and-files` (R26, spec 0038).
 *
 * Mirrors `workReportsListHandlers` byte-for-byte modulo URL and inner key
 * (`items` here, not `reports`). Realistic FileItem fixtures live alongside
 * the test (`test/commands/files/list.test.ts`).
 */
export const allDocsAndFilesListHandlers = {
  /**
   * `GET /all-docs-and-files?p=N` — paginated. `pages` keyed by 0-indexed
   * page number; missing pages return an empty page using the last-known
   * `per_page` and `total`. Same past-end behaviour as
   * `commentsListHandlers.paged` / `workReportsListHandlers.paged`.
   */
  paged(
    pages: Record<number, PagedFixture>,
    opts?: { onRequest?: (req: Request) => void },
  ): RequestHandler {
    return http.get(`${API_BASE}/all-docs-and-files`, ({ request }) => {
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
          data: { items: [] },
        });
      }
      return HttpResponse.json({
        total: ref.total,
        count: 0,
        page: p,
        per_page: ref.per_page,
        data: { items: [] },
      });
    });
  },

  /** `GET /all-docs-and-files` — 401. */
  unauthorized(): RequestHandler {
    return http.get(`${API_BASE}/all-docs-and-files`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `GET /all-docs-and-files` — 403. */
  forbidden(): RequestHandler {
    return http.get(`${API_BASE}/all-docs-and-files`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  /** `GET /all-docs-and-files` — 404. */
  notFound(): RequestHandler {
    return http.get(`${API_BASE}/all-docs-and-files`, () =>
      HttpResponse.json({ errors: ['Not found.'] }, { status: 404 }),
    );
  },

  /** `GET /all-docs-and-files` — 5xx for any page. */
  serverError(status = 500): RequestHandler {
    return http.get(`${API_BASE}/all-docs-and-files`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** `GET /all-docs-and-files` — 429 (Retry-After: 0 so retry exhaustion is fast). */
  rateLimited(): RequestHandler {
    return http.get(
      `${API_BASE}/all-docs-and-files`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** `GET /all-docs-and-files` — connection-closed (network error). */
  networkError(): RequestHandler {
    return http.get(`${API_BASE}/all-docs-and-files`, () => HttpResponse.error());
  },

  /**
   * Mid-stream fetch failure: succeeds for `p < failPage`, errors at
   * `p === failPage`. Drives the `PartialPagesError` unwrap path in the
   * leaf command.
   */
  midStreamError(opts: {
    pages: Record<number, PagedFixture>;
    failPage: number;
    status?: number;
  }): RequestHandler {
    const { pages, failPage, status = 500 } = opts;
    return http.get(`${API_BASE}/all-docs-and-files`, ({ request }) => {
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
   * Malformed 200 — `items[0].type` is not in the wire enum. Drives the
   * schema-validation error path (`FreeloApiError VALIDATION_ERROR`).
   */
  malformed(): RequestHandler {
    return http.get(`${API_BASE}/all-docs-and-files`, () =>
      HttpResponse.json({
        total: 1,
        count: 1,
        page: 0,
        per_page: 25,
        data: { items: [{ uuid: 'aaa', type: 'unknown_kind' }] },
      }),
    );
  },
};

/**
 * MSW handlers for `GET /file/{file_uuid}` (R27, spec 0039).
 *
 * The download endpoint returns a binary body (`application/octet-stream`).
 * MSW's `HttpResponse` accepts a `Uint8Array` body and we set the headers
 * explicitly so tests can assert the leaf's filename inference, byte counts,
 * and Content-Disposition handling.
 */
export const filesDownloadHandlers = {
  /**
   * 200 with the given bytes. Optional headers control the leaf's
   * filename inference and content-type echo.
   */
  downloadOk(opts: {
    bytes: Uint8Array | Buffer;
    contentType?: string;
    contentDisposition?: string;
    contentLength?: string;
  }): RequestHandler {
    return http.get(`${API_BASE}/file/:uuid`, () => {
      const headers: Record<string, string> = {
        'Content-Type': opts.contentType ?? 'application/octet-stream',
      };
      if (opts.contentDisposition !== undefined) {
        headers['Content-Disposition'] = opts.contentDisposition;
      }
      if (opts.contentLength !== undefined) {
        headers['Content-Length'] = opts.contentLength;
      } else {
        headers['Content-Length'] = String(opts.bytes.length);
      }
      // MSW expects an ArrayBuffer for binary bodies. `Buffer` is a Uint8Array
      // subclass; copy into a fresh ArrayBuffer to satisfy the typing.
      const ab = new ArrayBuffer(opts.bytes.length);
      new Uint8Array(ab).set(opts.bytes);
      return new HttpResponse(ab, { headers });
    });
  },

  /**
   * 200 with no body (response.body === null). Verifies the empty-body
   * branch in `requestBinary`.
   */
  downloadEmpty(opts?: { contentDisposition?: string }): RequestHandler {
    return http.get(`${API_BASE}/file/:uuid`, () => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '0',
      };
      if (opts?.contentDisposition !== undefined) {
        headers['Content-Disposition'] = opts.contentDisposition;
      }
      return new HttpResponse(null, { headers });
    });
  },

  /** 401. */
  unauthorized(): RequestHandler {
    return http.get(`${API_BASE}/file/:uuid`, () =>
      HttpResponse.json({ errors: [{ message: 'Invalid token' }] }, { status: 401 }),
    );
  },

  /** 403. */
  forbidden(): RequestHandler {
    return http.get(`${API_BASE}/file/:uuid`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  /** 404. */
  notFound(): RequestHandler {
    return http.get(`${API_BASE}/file/:uuid`, () =>
      HttpResponse.json({ errors: ['File not found.'] }, { status: 404 }),
    );
  },

  /** 5xx. */
  serverError(status = 500): RequestHandler {
    return http.get(`${API_BASE}/file/:uuid`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** 429 — Retry-After: 0 so retry exhaustion is instant (binary GETs do NOT
   *  retry per spec 0039 decision 05; the header is informational). */
  rateLimited(): RequestHandler {
    return http.get(
      `${API_BASE}/file/:uuid`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** Connection-closed (network error). */
  networkError(): RequestHandler {
    return http.get(`${API_BASE}/file/:uuid`, () => HttpResponse.error());
  },

  /**
   * Mid-stream failure. The response promises `Content-Length: 1024` but
   * the streamed body throws after `failAfter` bytes. Drives the
   * "temp file unlinked on streaming error" test (spec 0039 §5.3).
   */
  midStreamError(opts: { firstChunk: Uint8Array; declaredLength: number }): RequestHandler {
    const { firstChunk, declaredLength } = opts;
    return http.get(`${API_BASE}/file/:uuid`, () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(firstChunk);
          controller.error(new Error('mid-stream failure'));
        },
      });
      return new HttpResponse(stream, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(declaredLength),
        },
      });
    });
  },
};

/**
 * MSW handlers for the `notifications` resource group, R28 (spec 0040).
 *
 * Three endpoints:
 *   - `GET  /all-notifications`                                — paginated list
 *   - `POST /notification/{notification_id}/mark-read`      — flip is_unread → false
 *   - `POST /notification/{notification_id}/mark-unread`    — flip is_unread → true
 */
export const notificationsHandlers = {
  /* ---------------------------------------------------------------------
   *  GET /all-notifications — paginated list
   * ------------------------------------------------------------------- */

  /** Paged 200 keyed by 0-indexed page; missing pages return an empty page. */
  paged(
    pages: Record<number, PagedFixture>,
    opts?: { onRequest?: (req: Request) => void },
  ): RequestHandler {
    return http.get(`${API_BASE}/all-notifications`, ({ request }) => {
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
          data: { notifications: [] },
        });
      }
      return HttpResponse.json({
        total: ref.total,
        count: 0,
        page: p,
        per_page: ref.per_page,
        data: { notifications: [] },
      });
    });
  },

  /** Captures the request URL via the supplied callback (for query-string assertions). */
  spy(body: PagedFixture, capture: (req: Request) => void): RequestHandler {
    return http.get(`${API_BASE}/all-notifications`, ({ request }) => {
      capture(request);
      return HttpResponse.json(body);
    });
  },

  unauthorized(): RequestHandler {
    return http.get(`${API_BASE}/all-notifications`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  serverError(status = 500): RequestHandler {
    return http.get(`${API_BASE}/all-notifications`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /* ---------------------------------------------------------------------
   *  POST /notification/{id}/mark-read
   * ------------------------------------------------------------------- */

  markReadOk(): RequestHandler {
    return http.post(`${API_BASE}/notification/:id/mark-read`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  markReadOkSpy(capture: (req: Request) => void | Promise<void>): RequestHandler {
    return http.post(`${API_BASE}/notification/:id/mark-read`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({ result: 'success' });
    });
  },

  markReadFor(id: number): RequestHandler {
    return http.post(`${API_BASE}/notification/${id}/mark-read`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  markReadNotFound(id: number): RequestHandler {
    return http.post(`${API_BASE}/notification/${id}/mark-read`, () =>
      HttpResponse.json({ errors: ['Notification not found.'] }, { status: 404 }),
    );
  },

  markReadServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/notification/:id/mark-read`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /* ---------------------------------------------------------------------
   *  POST /notification/{id}/mark-unread
   * ------------------------------------------------------------------- */

  markUnreadOk(): RequestHandler {
    return http.post(`${API_BASE}/notification/:id/mark-unread`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  markUnreadOkSpy(capture: (req: Request) => void | Promise<void>): RequestHandler {
    return http.post(`${API_BASE}/notification/:id/mark-unread`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({ result: 'success' });
    });
  },

  markUnreadNotFound(id: number): RequestHandler {
    return http.post(`${API_BASE}/notification/${id}/mark-unread`, () =>
      HttpResponse.json({ errors: ['Notification not found.'] }, { status: 404 }),
    );
  },

  markUnreadServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/notification/:id/mark-unread`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },
};

/**
 * MSW handlers for `freelo projects create` (R29, spec 0042).
 *
 * Single endpoint: `POST /projects` returning `ProjectBasic { id, name }`.
 * Factories mirror `tasksCreateHandlers` for consistency.
 */
export const projectsCreateHandlers = {
  /** `POST /projects` — 200 with the supplied body. */
  ok(body: Record<string, unknown>): RequestHandler {
    return http.post(`${API_BASE}/projects`, () => HttpResponse.json(body));
  },

  /**
   * Match-on-body variant: `predicate(body, request)` decides whether the
   * supplied response or a 500 diagnostic comes back. Used to assert the exact
   * wire body.
   */
  okWhenBody(
    predicate: (body: unknown, request: Request) => boolean,
    response: Record<string, unknown>,
  ): RequestHandler {
    return http.post(`${API_BASE}/projects`, async ({ request }) => {
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

  /** `POST /projects` — 400 (server-side validation, e.g. invalid owner). */
  badRequest(message: string): RequestHandler {
    return http.post(`${API_BASE}/projects`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  /** `POST /projects` — 401. */
  unauthorized(): RequestHandler {
    return http.post(`${API_BASE}/projects`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `POST /projects` — 403. */
  forbidden(): RequestHandler {
    return http.post(`${API_BASE}/projects`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  /** `POST /projects` — 422. */
  unprocessable(message = 'Server-side validation failed.'): RequestHandler {
    return http.post(`${API_BASE}/projects`, () =>
      HttpResponse.json({ errors: [message] }, { status: 422 }),
    );
  },

  /** `POST /projects` — 429. */
  rateLimited(): RequestHandler {
    return http.post(
      `${API_BASE}/projects`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** `POST /projects` — 5xx. */
  serverError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/projects`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** `POST /projects` — closes the connection (network error). */
  networkError(): RequestHandler {
    return http.post(`${API_BASE}/projects`, () => HttpResponse.error());
  },
};

/**
 * MSW handlers for `freelo projects create-from-template` (R31, spec 0044).
 *
 * Single endpoint: `POST /project/create-from-template/{template_id}` returning
 * `ProjectFromTemplate { id, name, owner?, currency_iso? }`. Factories mirror
 * `projectsCreateHandlers` for consistency, parameterized by `templateId`.
 */
export const projectsCreateFromTemplateHandlers = {
  /** `POST /project/create-from-template/{templateId}` — 200 with the supplied body. */
  ok(templateId: number, body: Record<string, unknown>): RequestHandler {
    return http.post(`${API_BASE}/project/create-from-template/${templateId}`, () =>
      HttpResponse.json(body),
    );
  },

  /**
   * Match-on-body variant: `predicate(body, request)` decides whether the
   * supplied response or a 500 diagnostic comes back. Used to assert the exact
   * wire body.
   */
  okWhenBody(
    templateId: number,
    predicate: (body: unknown, request: Request) => boolean,
    response: Record<string, unknown>,
  ): RequestHandler {
    return http.post(
      `${API_BASE}/project/create-from-template/${templateId}`,
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

  /** 400 — server-side validation (e.g. invalid owner / out-of-template worker). */
  badRequest(templateId: number, message: string): RequestHandler {
    return http.post(`${API_BASE}/project/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  /** 401. */
  unauthorized(templateId: number): RequestHandler {
    return http.post(`${API_BASE}/project/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** 403. */
  forbidden(templateId: number): RequestHandler {
    return http.post(`${API_BASE}/project/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  /** 404 — template not found. */
  notFound(templateId: number): RequestHandler {
    return http.post(`${API_BASE}/project/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: ['Template not found.'] }, { status: 404 }),
    );
  },

  /** 422. */
  unprocessable(templateId: number, message = 'Server-side validation failed.'): RequestHandler {
    return http.post(`${API_BASE}/project/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: [message] }, { status: 422 }),
    );
  },

  /** 429 (Retry-After: 0). */
  rateLimited(templateId: number): RequestHandler {
    return http.post(
      `${API_BASE}/project/create-from-template/${templateId}`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** 5xx. */
  serverError(templateId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/project/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** Connection-closed (network error). */
  networkError(templateId: number): RequestHandler {
    return http.post(`${API_BASE}/project/create-from-template/${templateId}`, () =>
      HttpResponse.error(),
    );
  },
};

/**
 * MSW handlers for `freelo projects archive` and `freelo projects activate`
 * (R30, spec 0043). Two endpoints, identical shape:
 *   - `POST /project/{id}/archive` → SuccessResponse, server idempotent.
 *   - `POST /project/{id}/activate` → SuccessResponse, server idempotent
 *     (single entry for unarchive + undelete + already-active no-op).
 *
 * Each handler takes the verb so the same factory wires both paths.
 */
export const projectsTransitionHandlers = {
  /** `POST /project/{id}/archive|activate` — 200 success. */
  ok(verb: 'archive' | 'activate', projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/${verb}`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /** 401. */
  unauthorized(verb: 'archive' | 'activate', projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/${verb}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** 403. */
  forbidden(verb: 'archive' | 'activate', projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/${verb}`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  /** 404 (project missing). For archive/activate this is NOT idempotent. */
  notFound(verb: 'archive' | 'activate', projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/${verb}`, () =>
      HttpResponse.json({ errors: ['Project not found.'] }, { status: 404 }),
    );
  },

  /** 422 — used for activate's `PlanExceededException` case. */
  unprocessable(
    verb: 'archive' | 'activate',
    projectId: number,
    message = 'PlanExceededException',
  ): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/${verb}`, () =>
      HttpResponse.json({ errors: [message] }, { status: 422 }),
    );
  },

  /** 5xx. */
  serverError(verb: 'archive' | 'activate', projectId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/${verb}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** 429 (Retry-After: 0). */
  rateLimited(verb: 'archive' | 'activate', projectId: number): RequestHandler {
    return http.post(
      `${API_BASE}/project/${projectId}/${verb}`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** Connection-closed (network error). */
  networkError(verb: 'archive' | 'activate', projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/${verb}`, () => HttpResponse.error());
  },
};

/**
 * MSW handlers for `freelo projects delete` (R30, spec 0043).
 *
 * One endpoint:
 *   - `DELETE /project/{id}`
 *
 * Empty body, returns `SuccessResponse`. No pre-check GET (spec 0043
 * decision 1) — the DELETE response is authoritative; 404 → idempotent
 * already-deleted (decision 4 / mirrors R13).
 */
export const projectsDeleteHandlers = {
  /** `DELETE /project/{id}` — 200 success. */
  deleteOk(projectId: number): RequestHandler {
    return http.delete(`${API_BASE}/project/${projectId}`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /**
   * `DELETE /project/{id}` — 404. The command layer re-classifies this as
   * idempotent already-deleted (spec 0043 decision 4).
   */
  deleteNotFound(projectId: number): RequestHandler {
    return http.delete(`${API_BASE}/project/${projectId}`, () =>
      HttpResponse.json({ errors: ['Project not found.'] }, { status: 404 }),
    );
  },

  /** 401. */
  deleteUnauthorized(projectId: number): RequestHandler {
    return http.delete(`${API_BASE}/project/${projectId}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** 403. */
  deleteForbidden(projectId: number): RequestHandler {
    return http.delete(`${API_BASE}/project/${projectId}`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  /** 422. */
  deleteUnprocessable(
    projectId: number,
    message = 'Server-side validation failed.',
  ): RequestHandler {
    return http.delete(`${API_BASE}/project/${projectId}`, () =>
      HttpResponse.json({ errors: [message] }, { status: 422 }),
    );
  },

  /** 5xx. */
  deleteServerError(projectId: number, status = 500): RequestHandler {
    return http.delete(`${API_BASE}/project/${projectId}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** 429 (Retry-After: 0). */
  deleteRateLimited(projectId: number): RequestHandler {
    return http.delete(
      `${API_BASE}/project/${projectId}`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** Connection-closed (network error). */
  deleteNetworkError(projectId: number): RequestHandler {
    return http.delete(`${API_BASE}/project/${projectId}`, () => HttpResponse.error());
  },
};

/**
 * MSW handler factories for R32 `projects workers list` and `remove`
 * (spec 0045).
 *
 * Three endpoints:
 *   - `GET  /project/{id}/workers?p=N`               (list, paginated)
 *   - `POST /project/{id}/remove-workers/by-ids`     (remove, atomic array)
 *   - `POST /project/{id}/remove-workers/by-emails`  (remove, atomic array)
 *
 * The list-side reuses the same paginated wire shape as `projectShowHandlers.workersPaged`.
 */
export const projectsWorkersHandlers = {
  /**
   * `GET /project/{id}/workers?p=N` — single-page handler. Returns the
   * supplied `fixture` for any `?p` value (use `listPaged` for multi-page).
   */
  listOk(projectId: number, fixture: PagedFixture): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}/workers`, () => HttpResponse.json(fixture));
  },

  /**
   * `GET /project/{id}/workers?p=N` — multi-page. `pages` is keyed by 0-indexed
   * page number; missing pages return an empty page using the last-known
   * `per_page` and `total`. Mirrors `projectShowHandlers.workersPaged`.
   */
  listPaged(projectId: number, pages: Record<number, PagedFixture>): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}/workers`, ({ request }) => {
      const u = new URL(request.url);
      const p = Number(u.searchParams.get('p') ?? '0');
      const fix = pages[p];
      if (fix) return HttpResponse.json(fix);

      const ref = pages[Math.max(...Object.keys(pages).map(Number))];
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

  /**
   * Mid-stream `--all` failure: succeeds for `p < failPage`, errors at
   * `p === failPage`. Drives the `PartialPagesError` unwrap path on `list`.
   */
  listMidStreamError(opts: {
    projectId: number;
    pages: Record<number, PagedFixture>;
    failPage: number;
    status?: number;
  }): RequestHandler {
    const { projectId, pages, failPage, status = 500 } = opts;
    return http.get(`${API_BASE}/project/${projectId}/workers`, ({ request }) => {
      const u = new URL(request.url);
      const p = Number(u.searchParams.get('p') ?? '0');
      if (p >= failPage) {
        return HttpResponse.json({ errors: ['Internal server error.'] }, { status });
      }
      const fix = pages[p];
      if (fix) return HttpResponse.json(fix);
      return HttpResponse.json({
        total: 0,
        count: 0,
        page: p,
        per_page: 25,
        data: { workers: [] },
      });
    });
  },

  /** `GET /project/{id}/workers` — 401. */
  listUnauthorized(projectId: number): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}/workers`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `GET /project/{id}/workers` — 403. */
  listForbidden(projectId: number): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}/workers`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  /** `GET /project/{id}/workers` — 404. */
  listNotFound(projectId: number): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}/workers`, () =>
      HttpResponse.json({ errors: ['Project not found.'] }, { status: 404 }),
    );
  },

  /** `GET /project/{id}/workers` — 429 (Retry-After: 0). */
  listRateLimited(projectId: number): RequestHandler {
    return http.get(
      `${API_BASE}/project/${projectId}/workers`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** `GET /project/{id}/workers` — 5xx. */
  listServerError(projectId: number, status = 500): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}/workers`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** `POST /project/{id}/remove-workers/by-ids` — 200 success. */
  removeByIdsOk(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/remove-workers/by-ids`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /**
   * `POST /project/{id}/remove-workers/by-ids` — 200 success when the body
   * matches `predicate(body, request)`; otherwise 500 with a diagnostic.
   * Used to assert the exact wire body shape.
   */
  removeByIdsOkWhenBody(
    projectId: number,
    predicate: (body: unknown, request: Request) => boolean,
  ): RequestHandler {
    return http.post(
      `${API_BASE}/project/${projectId}/remove-workers/by-ids`,
      async ({ request }) => {
        const body: unknown = await request.clone().json();
        if (!predicate(body, request)) {
          return HttpResponse.json(
            { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
            { status: 500 },
          );
        }
        return HttpResponse.json({ result: 'success' });
      },
    );
  },

  /** `POST /project/{id}/remove-workers/by-emails` — 200 success. */
  removeByEmailsOk(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/remove-workers/by-emails`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /** Body-asserting variant for the by-emails endpoint. */
  removeByEmailsOkWhenBody(
    projectId: number,
    predicate: (body: unknown, request: Request) => boolean,
  ): RequestHandler {
    return http.post(
      `${API_BASE}/project/${projectId}/remove-workers/by-emails`,
      async ({ request }) => {
        const body: unknown = await request.clone().json();
        if (!predicate(body, request)) {
          return HttpResponse.json(
            { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
            { status: 500 },
          );
        }
        return HttpResponse.json({ result: 'success' });
      },
    );
  },

  /** `POST .../remove-workers/by-ids` — 400 with the supplied message. */
  removeByIdsBadRequest(projectId: number, message: string): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/remove-workers/by-ids`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  /** `POST .../remove-workers/by-emails` — 400 with the supplied message. */
  removeByEmailsBadRequest(projectId: number, message: string): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/remove-workers/by-emails`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  /** 401 — by-ids. */
  removeByIdsUnauthorized(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/remove-workers/by-ids`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** 403 — by-ids. */
  removeByIdsForbidden(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/remove-workers/by-ids`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  /** 404 — by-ids (project not found). */
  removeByIdsNotFound(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/remove-workers/by-ids`, () =>
      HttpResponse.json({ errors: ['Project not found.'] }, { status: 404 }),
    );
  },

  /** 422 — by-emails (typical for "email not in project"). */
  removeByEmailsUnprocessable(
    projectId: number,
    message = 'Email not currently in the project.',
  ): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/remove-workers/by-emails`, () =>
      HttpResponse.json({ errors: [message] }, { status: 422 }),
    );
  },

  /** 429 (Retry-After: 0) — by-ids. */
  removeByIdsRateLimited(projectId: number): RequestHandler {
    return http.post(
      `${API_BASE}/project/${projectId}/remove-workers/by-ids`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** 5xx — by-ids. */
  removeByIdsServerError(projectId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/remove-workers/by-ids`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** Network error — by-ids. */
  removeByIdsNetworkError(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/remove-workers/by-ids`, () =>
      HttpResponse.error(),
    );
  },
};

/**
 * MSW handler factories for `POST /users/manage-workers` (R33, spec 0046).
 *
 * One endpoint, multiple shapes. The default 200 result body has empty arrays
 * for all four buckets — useful when the test only cares about exit-0 / body
 * assertion. `okWithResult` and `okWhenBody` cover the two informative
 * variants.
 */
const INVITE_URL = `${API_BASE}/users/manage-workers`;

type InviteResultBody = {
  newly_invited_users_to_projects: unknown[];
  newly_created_users: { id?: number; email?: string }[];
  newly_invited_users: { id?: number; email?: string; projects_ids?: number[] }[];
  removed_users_from_projects: unknown[];
};

const INVITE_OK_DEFAULT: InviteResultBody = {
  newly_invited_users_to_projects: [],
  newly_created_users: [],
  newly_invited_users: [],
  removed_users_from_projects: [],
};

export const projectsInviteHandlers = {
  /** 200 with the default empty-buckets body. */
  ok(): RequestHandler {
    return http.post(INVITE_URL, () => HttpResponse.json(INVITE_OK_DEFAULT));
  },

  /** 200 with the supplied result body (override one or more buckets). */
  okWithResult(result: Partial<InviteResultBody>): RequestHandler {
    return http.post(INVITE_URL, () => HttpResponse.json({ ...INVITE_OK_DEFAULT, ...result }));
  },

  /**
   * 200 if the request body matches `predicate(body, request)`; otherwise 500
   * with a diagnostic. Used to assert the exact wire body shape.
   */
  okWhenBody(predicate: (body: unknown, request: Request) => boolean): RequestHandler {
    return http.post(INVITE_URL, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json(INVITE_OK_DEFAULT);
    });
  },

  /** 400 with a single string-form error. */
  badRequest(message: string): RequestHandler {
    return http.post(INVITE_URL, () => HttpResponse.json({ errors: [message] }, { status: 400 }));
  },

  /**
   * 400 with the exact `errors[]` array supplied. Used to drive the
   * field-level hint scan (spec 0046 decision 8).
   */
  badRequestWithErrors(errors: readonly string[]): RequestHandler {
    return http.post(INVITE_URL, () => HttpResponse.json({ errors: [...errors] }, { status: 400 }));
  },

  /** 401 — invalid or expired token. */
  unauthorized(): RequestHandler {
    return http.post(INVITE_URL, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** 403 — caller lacks permission on one or more projects. */
  forbidden(message = 'Role action forbidden.'): RequestHandler {
    return http.post(INVITE_URL, () => HttpResponse.json({ errors: [message] }, { status: 403 }));
  },

  /** 404 — one or more project ids not found. */
  notFound(): RequestHandler {
    return http.post(INVITE_URL, () =>
      HttpResponse.json({ errors: ['Project not found.'] }, { status: 404 }),
    );
  },

  /** 422 — typically plan-exceeded or semantically invalid request. */
  unprocessable(message = 'Plan limit exceeded.'): RequestHandler {
    return http.post(INVITE_URL, () => HttpResponse.json({ errors: [message] }, { status: 422 }));
  },

  /** 429 (Retry-After: 0) — rate-limited. */
  rateLimited(): RequestHandler {
    return http.post(
      INVITE_URL,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** 5xx server error. */
  serverError(status = 500): RequestHandler {
    return http.post(INVITE_URL, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** Network error (e.g. DNS failure, connection reset). */
  networkError(): RequestHandler {
    return http.post(INVITE_URL, () => HttpResponse.error());
  },
};

/**
 * MSW handlers for `freelo tasklists create` (R34, spec 0047).
 *
 * Single endpoint: `POST /project/{project_id}/tasklists` returning
 * `TasklistWithBudget { id, name, budget? }`. Factories mirror
 * `projectsCreateHandlers` for consistency, parameterized by `projectId`.
 */
export const tasklistsCreateHandlers = {
  /** `POST /project/{projectId}/tasklists` — 200 with the supplied body. */
  ok(projectId: number, body: Record<string, unknown>): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/tasklists`, () => HttpResponse.json(body));
  },

  /** Match-on-body variant: predicate decides whether the supplied response or 500 comes back. */
  okWhenBody(
    projectId: number,
    predicate: (body: unknown, request: Request) => boolean,
    response: Record<string, unknown>,
  ): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/tasklists`, async ({ request }) => {
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

  /** 400 — server-side validation. */
  badRequest(projectId: number, message: string): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/tasklists`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  /** 401. */
  unauthorized(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/tasklists`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** 403. */
  forbidden(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/tasklists`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  /** 404 — project missing. */
  notFound(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/tasklists`, () =>
      HttpResponse.json({ errors: ['Project not found.'] }, { status: 404 }),
    );
  },

  /** 422. */
  unprocessable(projectId: number, message = 'Server-side validation failed.'): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/tasklists`, () =>
      HttpResponse.json({ errors: [message] }, { status: 422 }),
    );
  },

  /** 429 (Retry-After: 0). */
  rateLimited(projectId: number): RequestHandler {
    return http.post(
      `${API_BASE}/project/${projectId}/tasklists`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** 5xx. */
  serverError(projectId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/tasklists`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** Connection-closed (network error). */
  networkError(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/tasklists`, () => HttpResponse.error());
  },
};

/**
 * MSW handlers for `freelo tasklists create-from-template` (R34, spec 0047).
 *
 * Single endpoint: `POST /tasklist/create-from-template/{template_id}`
 * returning `{ id, name, tasks: [{ id, name }] }`. Factories mirror
 * `projectsCreateFromTemplateHandlers` for consistency.
 */
export const tasklistsCreateFromTemplateHandlers = {
  /** `POST /tasklist/create-from-template/{templateId}` — 200 with the supplied body. */
  ok(templateId: number, body: Record<string, unknown>): RequestHandler {
    return http.post(`${API_BASE}/tasklist/create-from-template/${templateId}`, () =>
      HttpResponse.json(body),
    );
  },

  /** Match-on-body variant. */
  okWhenBody(
    templateId: number,
    predicate: (body: unknown, request: Request) => boolean,
    response: Record<string, unknown>,
  ): RequestHandler {
    return http.post(
      `${API_BASE}/tasklist/create-from-template/${templateId}`,
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

  /** 400 — server-side validation. */
  badRequest(templateId: number, message: string): RequestHandler {
    return http.post(`${API_BASE}/tasklist/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  /** 401. */
  unauthorized(templateId: number): RequestHandler {
    return http.post(`${API_BASE}/tasklist/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** 403. */
  forbidden(templateId: number): RequestHandler {
    return http.post(`${API_BASE}/tasklist/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  /** 404 — template not found. */
  notFound(templateId: number): RequestHandler {
    return http.post(`${API_BASE}/tasklist/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: ['Template not found.'] }, { status: 404 }),
    );
  },

  /** 422. */
  unprocessable(templateId: number, message = 'Server-side validation failed.'): RequestHandler {
    return http.post(`${API_BASE}/tasklist/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: [message] }, { status: 422 }),
    );
  },

  /** 429 (Retry-After: 0). */
  rateLimited(templateId: number): RequestHandler {
    return http.post(
      `${API_BASE}/tasklist/create-from-template/${templateId}`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** 5xx. */
  serverError(templateId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/tasklist/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** Connection-closed (network error). */
  networkError(templateId: number): RequestHandler {
    return http.post(`${API_BASE}/tasklist/create-from-template/${templateId}`, () =>
      HttpResponse.error(),
    );
  },
};

/**
 * MSW handlers for `freelo tasks remind set` (R35, spec 0049).
 *
 * Single endpoint:
 *   - `POST /task/{task_id}/reminder` — `{ remind_at, task: { id, name } }`
 *
 * Per `docs/api/freelo-api.yaml:2067-2115`, body is `{ remind_at: ISO 8601 }`.
 * Server upserts and overwrites on a second call (yaml :2081).
 */
export const tasksRemindSetHandlers = {
  /** `POST /task/{id}/reminder` — 200 with the supplied response body. */
  ok(taskId: number, body: Record<string, unknown>): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/reminder`, () => HttpResponse.json(body));
  },

  /**
   * Match-on-body variant: `predicate(body, request)` decides whether the
   * supplied response or a 500 diagnostic comes back. Useful when a test
   * needs to assert the exact wire body (e.g. UTC normalization).
   */
  okWhenBody(
    taskId: number,
    predicate: (body: unknown, request: Request) => boolean,
    response: Record<string, unknown>,
  ): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/reminder`, async ({ request }) => {
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

  /** `POST /task/{id}/reminder` — 401. */
  unauthorized(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/reminder`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `POST /task/{id}/reminder` — 403. */
  forbidden(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/reminder`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  /** `POST /task/{id}/reminder` — 404 (task not found). */
  notFound(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/reminder`, () =>
      HttpResponse.json({ errors: ['Task not found.'] }, { status: 404 }),
    );
  },

  /** `POST /task/{id}/reminder` — 5xx. */
  serverError(taskId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/reminder`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },
};

/**
 * MSW handlers for `freelo tasks remind clear` (R35, spec 0049).
 *
 * Single endpoint:
 *   - `DELETE /task/{task_id}/reminder` — `SuccessResponse` (200 even when
 *     no reminder existed; yaml :2125).
 */
export const tasksRemindClearHandlers = {
  /** `DELETE /task/{id}/reminder` — 200 success. */
  ok(taskId: number): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}/reminder`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /**
   * `DELETE /task/{id}/reminder` — 404. Defensive forward-compat path; the
   * documented behavior is 200 for the no-reminder case (yaml :2125), but
   * the command layer re-classifies a 404 as `already_in_target_state: true`
   * for safety.
   */
  notFound(taskId: number): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}/reminder`, () =>
      HttpResponse.json({ errors: ['Reminder not found.'] }, { status: 404 }),
    );
  },

  /** `DELETE /task/{id}/reminder` — 401. */
  unauthorized(taskId: number): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}/reminder`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `DELETE /task/{id}/reminder` — 5xx. */
  serverError(taskId: number, status = 500): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}/reminder`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },
};

/**
 * MSW handlers for `freelo tasks share` (R36, spec 0050).
 *
 * Single endpoint:
 *   - `GET /public-link/task/{task_id}` — `{ url: <string> }`
 *
 * Per `docs/api/freelo-api.yaml:2137-2165`, this is a "GET that creates":
 * first call mints the URL, subsequent calls return the same one. The CLI
 * cannot distinguish the two cases on the wire (spec 0050 decision 2).
 *
 * Note on the verb: the roadmap shorthand says POST; the authoritative
 * OpenAPI documents this as GET. Tests follow the yaml (spec 0050
 * decision 1).
 */
export const tasksShareHandlers = {
  /** `GET /public-link/task/{id}` — 200 with `{ url }`. */
  ok(taskId: number, url: string): RequestHandler {
    return http.get(`${API_BASE}/public-link/task/${taskId}`, () => HttpResponse.json({ url }));
  },

  /**
   * `GET /public-link/task/{id}` — 200 with a body that DOES NOT contain
   * `url`. Exercises the schema-validation error path (zod rejects the
   * body; client surfaces `FreeloApiError` with `VALIDATION_ERROR`).
   */
  okMissingUrl(taskId: number): RequestHandler {
    return http.get(`${API_BASE}/public-link/task/${taskId}`, () => HttpResponse.json({}));
  },

  /** `GET /public-link/task/{id}` — 401. */
  unauthorized(taskId: number): RequestHandler {
    return http.get(`${API_BASE}/public-link/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `GET /public-link/task/{id}` — 403. */
  forbidden(taskId: number): RequestHandler {
    return http.get(`${API_BASE}/public-link/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  /** `GET /public-link/task/{id}` — 404 (task not found). */
  notFound(taskId: number): RequestHandler {
    return http.get(`${API_BASE}/public-link/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Task not found.'] }, { status: 404 }),
    );
  },

  /** `GET /public-link/task/{id}` — 5xx. */
  serverError(taskId: number, status = 500): RequestHandler {
    return http.get(`${API_BASE}/public-link/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },
};

/**
 * MSW handlers for `freelo tasks unshare` (R36, spec 0050).
 *
 * Single endpoint:
 *   - `DELETE /public-link/task/{task_id}` — `SuccessResponse`.
 *
 * The OpenAPI is silent on the no-link case; the command layer maps a
 * 404 to `already_in_target_state: true` (spec 0050 decision 5,
 * mirroring R13 / R35 idempotency on destructive ops).
 */
export const tasksUnshareHandlers = {
  /** `DELETE /public-link/task/{id}` — 200 success. */
  ok(taskId: number): RequestHandler {
    return http.delete(`${API_BASE}/public-link/task/${taskId}`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /**
   * `DELETE /public-link/task/{id}` — 404. Defensive forward-compat path:
   * the OpenAPI does not document a 404 for the no-link case, but if
   * Freelo ever tightens the endpoint we re-classify the 404 as
   * `already_in_target_state: true`.
   */
  notFound(taskId: number): RequestHandler {
    return http.delete(`${API_BASE}/public-link/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Public link not found.'] }, { status: 404 }),
    );
  },

  /** `DELETE /public-link/task/{id}` — 401. */
  unauthorized(taskId: number): RequestHandler {
    return http.delete(`${API_BASE}/public-link/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `DELETE /public-link/task/{id}` — 5xx. */
  serverError(taskId: number, status = 500): RequestHandler {
    return http.delete(`${API_BASE}/public-link/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },
};

/**
 * MSW handlers for `freelo tasks estimate set` (R37, spec 0051).
 *
 * Two endpoint variants (path differs by whether `--user` is set):
 *   - `POST /task/{task_id}/total-time-estimate`           (total scope)
 *   - `POST /task/{task_id}/users-time-estimates/{user_id}` (per-user scope)
 *
 * Per `docs/api/freelo-api.yaml:2254-2289` and `:2311-2352`, body is
 * `{ minutes: <int> }`. Server upserts on every call (yaml :2267, :2324) —
 * a second call overwrites the prior value. Response is the generic
 * `SuccessResponse`.
 */
export const tasksEstimateSetHandlers = {
  /** `POST /task/{id}/total-time-estimate` — 200 success. */
  okTotal(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/total-time-estimate`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /** `POST /task/{id}/users-time-estimates/{user_id}` — 200 success. */
  okUser(taskId: number, userId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/users-time-estimates/${userId}`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /**
   * Match-on-body variant for the total path: `predicate(body)` decides
   * whether the supplied response or a 500 diagnostic comes back. Useful
   * when a test asserts the wire body shape (`{ minutes: <n> }`).
   */
  okTotalWhenBody(taskId: number, predicate: (body: unknown) => boolean): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/total-time-estimate`, async ({ request }) => {
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

  /** Match-on-body variant for the per-user path. */
  okUserWhenBody(
    taskId: number,
    userId: number,
    predicate: (body: unknown) => boolean,
  ): RequestHandler {
    return http.post(
      `${API_BASE}/task/${taskId}/users-time-estimates/${userId}`,
      async ({ request }) => {
        const body: unknown = await request.clone().json();
        if (!predicate(body)) {
          return HttpResponse.json(
            { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
            { status: 500 },
          );
        }
        return HttpResponse.json({ result: 'success' });
      },
    );
  },

  /** `POST /task/{id}/total-time-estimate` — 401. */
  unauthorizedTotal(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/total-time-estimate`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `POST /task/{id}/total-time-estimate` — 403. */
  forbiddenTotal(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/total-time-estimate`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  /** `POST /task/{id}/total-time-estimate` — 404 (task not found). */
  notFoundTotal(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/total-time-estimate`, () =>
      HttpResponse.json({ errors: ['Task not found.'] }, { status: 404 }),
    );
  },

  /** `POST /task/{id}/total-time-estimate` — 5xx. */
  serverErrorTotal(taskId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/total-time-estimate`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },
};

/**
 * MSW handlers for `freelo tasks estimate clear` (R37, spec 0051).
 *
 * Two endpoint variants:
 *   - `DELETE /task/{task_id}/total-time-estimate`
 *   - `DELETE /task/{task_id}/users-time-estimates/{user_id}`
 *
 * Both return `SuccessResponse` (200 even when no estimate existed —
 * yaml :2299 and :2362). The CLI re-classifies a 404 as
 * `already_in_target_state: true` defensively (forward-compat).
 */
export const tasksEstimateClearHandlers = {
  /** `DELETE /task/{id}/total-time-estimate` — 200 success. */
  okTotal(taskId: number): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}/total-time-estimate`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /** `DELETE /task/{id}/users-time-estimates/{user_id}` — 200 success. */
  okUser(taskId: number, userId: number): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}/users-time-estimates/${userId}`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /**
   * `DELETE /task/{id}/total-time-estimate` — 404. Defensive forward-compat
   * path; the documented behavior is 200 for the no-estimate case
   * (yaml :2299), but the command layer re-classifies a 404 as
   * `already_in_target_state: true` for safety.
   */
  notFoundTotal(taskId: number): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}/total-time-estimate`, () =>
      HttpResponse.json({ errors: ['Estimate not found.'] }, { status: 404 }),
    );
  },

  /** `DELETE /task/{id}/users-time-estimates/{user_id}` — 404 (defensive). */
  notFoundUser(taskId: number, userId: number): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}/users-time-estimates/${userId}`, () =>
      HttpResponse.json({ errors: ['Estimate not found.'] }, { status: 404 }),
    );
  },

  /** `DELETE /task/{id}/total-time-estimate` — 401. */
  unauthorizedTotal(taskId: number): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}/total-time-estimate`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `DELETE /task/{id}/total-time-estimate` — 5xx. */
  serverErrorTotal(taskId: number, status = 500): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}/total-time-estimate`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },
};

/**
 * MSW handlers for `freelo tasks project add` (R38, spec 0052).
 *
 * Wire: `POST /task/{task_id}/projects` with body `{ tasklist_id: <int> }`.
 * Response (yaml :1923-1937): `{ task: { id, uuid } }`.
 *
 * `--tasklist` is repeatable on the CLI; each value fans out to one POST.
 * `okOneShot` issues a different child-task id per call so tests can verify
 * the assignments echo carries distinct ids per tasklist.
 */
export const tasksProjectAddHandlers = {
  /** Single 200 — every POST returns the same fixed child-task id. */
  ok(taskId: number, childTaskId = 9001, childUuid = 'abc-001'): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/projects`, () =>
      HttpResponse.json({ task: { id: childTaskId, uuid: childUuid } }),
    );
  },

  /**
   * 200, with the per-call response chosen by tasklist_id (read from the
   * request body). Useful when N --tasklist values fan out to N POSTs and
   * the test asserts the assignments echo carries the right per-tasklist
   * child id.
   *
   * `mapping` keys are tasklist ids; values are `{ child_task_id, child_task_uuid }`.
   * Unknown tasklist ids fall through to a 500 diagnostic (forces a test fix).
   */
  okPerTasklist(
    taskId: number,
    mapping: Record<number, { childTaskId: number; childUuid: string }>,
  ): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/projects`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      const tlid =
        typeof body === 'object' &&
        body !== null &&
        'tasklist_id' in body &&
        typeof (body as Record<string, unknown>)['tasklist_id'] === 'number'
          ? ((body as Record<string, unknown>)['tasklist_id'] as number)
          : -1;
      const entry = mapping[tlid];
      if (entry === undefined) {
        return HttpResponse.json(
          { errors: [`Unknown tasklist_id in test mapping: ${String(tlid)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json({
        task: { id: entry.childTaskId, uuid: entry.childUuid },
      });
    });
  },

  /**
   * 200 for the first call; 403 (AclException) for subsequent calls. Used to
   * test the mid-fan-out failure path: `assignments` echoes the first call,
   * the second bubbles as `FreeloApiError`.
   */
  okThen403(taskId: number, childTaskId = 9001, childUuid = 'abc-001'): RequestHandler {
    let calls = 0;
    return http.post(`${API_BASE}/task/${taskId}/projects`, () => {
      calls += 1;
      if (calls === 1) {
        return HttpResponse.json({ task: { id: childTaskId, uuid: childUuid } });
      }
      return HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 });
    });
  },

  /** 401 unauthorized. */
  unauthorized(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/projects`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** 403 forbidden. */
  forbidden(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/projects`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  /** 404 (task or tasklist not found). */
  notFound(taskId: number): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/projects`, () =>
      HttpResponse.json({ errors: ['Task or tasklist not found.'] }, { status: 404 }),
    );
  },

  /** 5xx server error. */
  serverError(taskId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/projects`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /**
   * Body-capturing 200 — every request body is appended to `captured` and a
   * fixed success body is returned. Used by tests asserting the wire body
   * shape across N fan-out POSTs. Calls `await request.json()` directly (no
   * clone()) — MSW guarantees the body is consumable once per handler.
   */
  okCapturing(
    taskId: number,
    captured: unknown[],
    childTaskId = 9001,
    childUuid = 'abc-001',
  ): RequestHandler {
    return http.post(`${API_BASE}/task/${taskId}/projects`, async ({ request }) => {
      captured.push(await request.json());
      return HttpResponse.json({ task: { id: childTaskId, uuid: childUuid } });
    });
  },
};

/**
 * MSW handlers for `freelo tasks project remove` (R38, spec 0052).
 *
 * Wire: `DELETE /task/{task_id}/projects/{project_id}`. Response: `SuccessResponse`.
 * 403 when removing the primary project (yaml :1984). 404 when the task is not
 * present in that project (yaml :1985 — first-class idempotency signal).
 */
export const tasksProjectRemoveHandlers = {
  ok(taskId: number, projectId: number): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}/projects/${projectId}`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /** 401 unauthorized. */
  unauthorized(taskId: number, projectId: number): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}/projects/${projectId}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** 403 — primary-project removal attempt (AclException, yaml :1984). */
  forbidden(taskId: number, projectId: number): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}/projects/${projectId}`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  /** 404 — task not present in given project (yaml :1985). */
  notFound(taskId: number, projectId: number): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}/projects/${projectId}`, () =>
      HttpResponse.json({ errors: ['Task not in project.'] }, { status: 404 }),
    );
  },

  /** 5xx server error. */
  serverError(taskId: number, projectId: number, status = 500): RequestHandler {
    return http.delete(`${API_BASE}/task/${taskId}/projects/${projectId}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },
};

/**
 * MSW handlers for `freelo tasks relations` (R38, spec 0052).
 *
 * Wire: `GET /task/{task_id}/relations`. Response: `{ relations: TaskRelation[] }`.
 * Empty array is a valid 200.
 */
export const tasksRelationsHandlers = {
  /** 200 with the supplied relations array (defaults to empty). */
  ok(taskId: number, relations: Array<Record<string, unknown>> = []): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}/relations`, () => HttpResponse.json({ relations }));
  },

  unauthorized(taskId: number): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}/relations`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  forbidden(taskId: number): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}/relations`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  notFound(taskId: number): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}/relations`, () =>
      HttpResponse.json({ errors: ['Task not found.'] }, { status: 404 }),
    );
  },

  serverError(taskId: number, status = 500): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}/relations`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },
};

/**
 * MSW handlers for `freelo tasks find-relations` (R38, spec 0052).
 *
 * Wire: `POST /tasks/relations` with body `{ task_ids: [<int>, ...] }`.
 * Response: `{ tasks: [{ task_id, relations }, ...] }`. Tasks the caller
 * cannot access are silently omitted (yaml :1622) — the `okSubset` factory
 * lets tests simulate this gap.
 */
export const tasksFindRelationsHandlers = {
  /** 200 with the supplied tasks array. */
  ok(tasks: Array<Record<string, unknown>>): RequestHandler {
    return http.post(`${API_BASE}/tasks/relations`, () => HttpResponse.json({ tasks }));
  },

  /**
   * 200 — body inspection variant. The handler asserts a predicate against
   * the request body (typically `body.task_ids` shape) before returning the
   * supplied tasks.
   */
  okWhenBody(
    predicate: (body: unknown) => boolean,
    tasks: Array<Record<string, unknown>>,
  ): RequestHandler {
    return http.post(`${API_BASE}/tasks/relations`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json({ tasks });
    });
  },

  unauthorized(): RequestHandler {
    return http.post(`${API_BASE}/tasks/relations`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  badRequest(): RequestHandler {
    return http.post(`${API_BASE}/tasks/relations`, () =>
      HttpResponse.json({ errors: ['Invalid request body.'] }, { status: 400 }),
    );
  },

  serverError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/tasks/relations`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },
};

/**
 * MSW handlers for `freelo tasks create-from-template` (R39, spec 0053).
 *
 * Single endpoint:
 *   - `POST /task/create-from-template/{template_id}` — yaml :2187-2253.
 *
 * Body: `{ task_id, target_project_id?, target_tasklist_id?,
 * preset_date_from?, users_ids? }`.
 * Response: `{ id, name, tasklist: { id, name } }`.
 */
export const tasksCreateFromTemplateHandlers = {
  /** `POST /task/create-from-template/{templateId}` — 200 with the supplied body. */
  ok(templateId: number, body: Record<string, unknown>): RequestHandler {
    return http.post(`${API_BASE}/task/create-from-template/${templateId}`, () =>
      HttpResponse.json(body),
    );
  },

  /** Match-on-body variant. */
  okWhenBody(
    templateId: number,
    predicate: (body: unknown, request: Request) => boolean,
    response: Record<string, unknown>,
  ): RequestHandler {
    return http.post(`${API_BASE}/task/create-from-template/${templateId}`, async ({ request }) => {
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

  /** 400 — server-side validation. */
  badRequest(templateId: number, message: string): RequestHandler {
    return http.post(`${API_BASE}/task/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  /** 401. */
  unauthorized(templateId: number): RequestHandler {
    return http.post(`${API_BASE}/task/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** 403. */
  forbidden(templateId: number): RequestHandler {
    return http.post(`${API_BASE}/task/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  /** 404 — template not found. */
  notFound(templateId: number): RequestHandler {
    return http.post(`${API_BASE}/task/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: ['Template not found.'] }, { status: 404 }),
    );
  },

  /** 422. */
  unprocessable(templateId: number, message = 'Server-side validation failed.'): RequestHandler {
    return http.post(`${API_BASE}/task/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: [message] }, { status: 422 }),
    );
  },

  /** 429 (Retry-After: 0). */
  rateLimited(templateId: number): RequestHandler {
    return http.post(
      `${API_BASE}/task/create-from-template/${templateId}`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** 5xx. */
  serverError(templateId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/task/create-from-template/${templateId}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** Connection-closed (network error). */
  networkError(templateId: number): RequestHandler {
    return http.post(`${API_BASE}/task/create-from-template/${templateId}`, () =>
      HttpResponse.error(),
    );
  },
};

/**
 * MSW handlers for `freelo custom-fields types` (R40, spec 0054).
 *
 * Wire: `GET /custom-field/get-types`. No path params.
 * Response: `{ custom_field_types: [{ uuid, name }, …] }`.
 */
export const customFieldsTypesHandlers = {
  /** 200 with the supplied type catalog (defaults to the three documented types). */
  ok(types?: Array<Record<string, unknown>>): RequestHandler {
    const body = {
      custom_field_types: types ?? [
        { uuid: '2f7bfe3a-c950-470e-b910-95b4caf5dc4f', name: 'text' },
        { uuid: 'b1e56fa9-a97a-429b-8ab4-82bebe58933a', name: 'number' },
        { uuid: 'f9729a8f-d340-40e4-b2c0-dc46c37e18ce', name: 'enum' },
      ],
    };
    return http.get(`${API_BASE}/custom-field/get-types`, () => HttpResponse.json(body));
  },

  /** 200 with empty `custom_field_types: []`. */
  okEmpty(): RequestHandler {
    return http.get(`${API_BASE}/custom-field/get-types`, () =>
      HttpResponse.json({ custom_field_types: [] }),
    );
  },

  unauthorized(): RequestHandler {
    return http.get(`${API_BASE}/custom-field/get-types`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  rateLimited(): RequestHandler {
    return http.get(`${API_BASE}/custom-field/get-types`, () =>
      HttpResponse.json({ errors: ['Too many requests.'] }, { status: 429 }),
    );
  },

  serverError(status = 500): RequestHandler {
    return http.get(`${API_BASE}/custom-field/get-types`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  networkError(): RequestHandler {
    return http.get(`${API_BASE}/custom-field/get-types`, () => HttpResponse.error());
  },
};

/**
 * MSW handlers for `freelo custom-fields list` (R40, spec 0054).
 *
 * Wire: `GET /custom-field/find-by-project/{project_id}`.
 * Response: `{ custom_fields: CustomField[], is_commander: boolean }`.
 */
export const customFieldsListHandlers = {
  /** 200 with the supplied custom_fields array + is_commander flag. */
  ok(
    projectId: number,
    customFields: Array<Record<string, unknown>>,
    isCommander = true,
  ): RequestHandler {
    return http.get(`${API_BASE}/custom-field/find-by-project/${projectId}`, () =>
      HttpResponse.json({ custom_fields: customFields, is_commander: isCommander }),
    );
  },

  /** 200 with empty `custom_fields: []` and `is_commander: false`. */
  okEmpty(projectId: number): RequestHandler {
    return http.get(`${API_BASE}/custom-field/find-by-project/${projectId}`, () =>
      HttpResponse.json({ custom_fields: [], is_commander: false }),
    );
  },

  /** 400 — server-side validation. The message can be set so tests can hit
   *  the `project_id`-mention branch of `rewriteApiHint`. */
  badRequest(projectId: number, message = 'Invalid request body.'): RequestHandler {
    return http.get(`${API_BASE}/custom-field/find-by-project/${projectId}`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  unauthorized(projectId: number): RequestHandler {
    return http.get(`${API_BASE}/custom-field/find-by-project/${projectId}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  forbidden(projectId: number): RequestHandler {
    return http.get(`${API_BASE}/custom-field/find-by-project/${projectId}`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  notFound(projectId: number): RequestHandler {
    return http.get(`${API_BASE}/custom-field/find-by-project/${projectId}`, () =>
      HttpResponse.json({ errors: ['Project not found.'] }, { status: 404 }),
    );
  },

  rateLimited(projectId: number): RequestHandler {
    return http.get(`${API_BASE}/custom-field/find-by-project/${projectId}`, () =>
      HttpResponse.json({ errors: ['Too many requests.'] }, { status: 429 }),
    );
  },

  serverError(projectId: number, status = 500): RequestHandler {
    return http.get(`${API_BASE}/custom-field/find-by-project/${projectId}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  networkError(projectId: number): RequestHandler {
    return http.get(`${API_BASE}/custom-field/find-by-project/${projectId}`, () =>
      HttpResponse.error(),
    );
  },
};

/**
 * MSW handlers for `freelo custom-fields create / rename / delete / restore`
 * (R41, spec 0055).
 *
 * Wires:
 *   - `POST   /custom-field/create/{project_id}`
 *   - `POST   /custom-field/rename/{uuid}`
 *   - `DELETE /custom-field/delete/{uuid}`
 *   - `POST   /custom-field/restore/{uuid}`
 *
 * Mirrors the `projectLabelsHandlers` shape one-for-one. `delete` and
 * `restore` expose a `notFound` arm specifically for the idempotency
 * test matrix.
 */
export const customFieldsCrudHandlers = {
  /* ---------------------------------------------------------------------
   *  POST /custom-field/create/{project_id}
   * ------------------------------------------------------------------- */

  createOk(projectId: number, customField?: Record<string, unknown>): RequestHandler {
    const body = {
      custom_field: customField ?? {
        uuid: '11111111-1111-1111-1111-111111111111',
        name: 'Severity',
        custom_fields_types_uuid: '2f7bfe3a-c950-470e-b910-95b4caf5dc4f',
        project_id: projectId,
        author_id: 5,
        date_add: '2026-05-10T00:00:00Z',
        priority: 1,
      },
    };
    return http.post(`${API_BASE}/custom-field/create/${projectId}`, () => HttpResponse.json(body));
  },

  createOkWhenBody(
    projectId: number,
    predicate: (body: unknown, request: Request) => boolean,
    response?: Record<string, unknown>,
  ): RequestHandler {
    return http.post(`${API_BASE}/custom-field/create/${projectId}`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json(
        response ?? {
          custom_field: {
            uuid: '11111111-1111-1111-1111-111111111111',
            name: 'Severity',
            custom_fields_types_uuid: '2f7bfe3a-c950-470e-b910-95b4caf5dc4f',
            project_id: projectId,
            author_id: 5,
            date_add: '2026-05-10T00:00:00Z',
            priority: 1,
          },
        },
      );
    });
  },

  createBadRequest(projectId: number, message = 'Invalid request body.'): RequestHandler {
    return http.post(`${API_BASE}/custom-field/create/${projectId}`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  createUnauthorized(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/custom-field/create/${projectId}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  createForbidden(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/custom-field/create/${projectId}`, () =>
      HttpResponse.json({ errors: ['UserIsNotProjectCommander'] }, { status: 403 }),
    );
  },

  createPlanExceeded(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/custom-field/create/${projectId}`, () =>
      HttpResponse.json({ errors: ['PlanExceededException'] }, { status: 402 }),
    );
  },

  createNotFound(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/custom-field/create/${projectId}`, () =>
      HttpResponse.json({ errors: ['Project not found.'] }, { status: 404 }),
    );
  },

  createServerError(projectId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/custom-field/create/${projectId}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  createRateLimited(projectId: number): RequestHandler {
    return http.post(
      `${API_BASE}/custom-field/create/${projectId}`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  createNetworkError(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/custom-field/create/${projectId}`, () => HttpResponse.error());
  },

  /* ---------------------------------------------------------------------
   *  POST /custom-field/rename/{uuid}
   * ------------------------------------------------------------------- */

  renameOk(customField?: Record<string, unknown>): RequestHandler {
    const body = {
      custom_field: customField ?? {
        uuid: '11111111-1111-1111-1111-111111111111',
        name: 'New Name',
        custom_fields_types_uuid: '2f7bfe3a-c950-470e-b910-95b4caf5dc4f',
        project_id: 100,
        author_id: 5,
        date_add: '2026-05-10T00:00:00Z',
        priority: 1,
      },
    };
    return http.post(`${API_BASE}/custom-field/rename/:uuid`, () => HttpResponse.json(body));
  },

  renameOkWhenBody(predicate: (body: unknown, request: Request) => boolean): RequestHandler {
    return http.post(`${API_BASE}/custom-field/rename/:uuid`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json({
        custom_field: {
          uuid: '11111111-1111-1111-1111-111111111111',
          name: 'New Name',
          custom_fields_types_uuid: '2f7bfe3a-c950-470e-b910-95b4caf5dc4f',
          project_id: 100,
          author_id: 5,
          date_add: '2026-05-10T00:00:00Z',
          priority: 1,
        },
      });
    });
  },

  renameBadRequest(message = 'Invalid request body.'): RequestHandler {
    return http.post(`${API_BASE}/custom-field/rename/:uuid`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  renameUnauthorized(): RequestHandler {
    return http.post(`${API_BASE}/custom-field/rename/:uuid`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  renameForbidden(): RequestHandler {
    return http.post(`${API_BASE}/custom-field/rename/:uuid`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  renameNotFound(): RequestHandler {
    return http.post(`${API_BASE}/custom-field/rename/:uuid`, () =>
      HttpResponse.json({ errors: ['Custom field not found.'] }, { status: 404 }),
    );
  },

  renameServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/custom-field/rename/:uuid`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  renameRateLimited(): RequestHandler {
    return http.post(
      `${API_BASE}/custom-field/rename/:uuid`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /* ---------------------------------------------------------------------
   *  DELETE /custom-field/delete/{uuid}  (idempotent 404)
   * ------------------------------------------------------------------- */

  deleteOk(): RequestHandler {
    return http.delete(`${API_BASE}/custom-field/delete/:uuid`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /** Idempotency arm — 404 → CLI re-classifies as already_in_target_state: true. */
  deleteNotFound(): RequestHandler {
    return http.delete(`${API_BASE}/custom-field/delete/:uuid`, () =>
      HttpResponse.json({ errors: ['Not found.'] }, { status: 404 }),
    );
  },

  deleteForbidden(): RequestHandler {
    return http.delete(`${API_BASE}/custom-field/delete/:uuid`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  deleteUnauthorized(): RequestHandler {
    return http.delete(`${API_BASE}/custom-field/delete/:uuid`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  deleteServerError(status = 500): RequestHandler {
    return http.delete(`${API_BASE}/custom-field/delete/:uuid`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  deleteRateLimited(): RequestHandler {
    return http.delete(
      `${API_BASE}/custom-field/delete/:uuid`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** Per-uuid router for delete — different responses per uuid. */
  deletePerUuidRouter(routes: Record<string, () => Response | HttpResponse>): RequestHandler {
    return http.delete(`${API_BASE}/custom-field/delete/:uuid`, ({ params }) => {
      const u = String(params['uuid']);
      const route = routes[u];
      if (route) return route();
      return HttpResponse.json({ result: 'success' });
    });
  },

  /* ---------------------------------------------------------------------
   *  POST /custom-field/restore/{uuid}  (idempotent 404)
   * ------------------------------------------------------------------- */

  restoreOk(customField?: Record<string, unknown>): RequestHandler {
    const body = {
      custom_field: customField ?? {
        uuid: '11111111-1111-1111-1111-111111111111',
        name: 'Severity',
        custom_fields_types_uuid: '2f7bfe3a-c950-470e-b910-95b4caf5dc4f',
        project_id: 100,
        author_id: 5,
        date_add: '2026-05-10T00:00:00Z',
        priority: 1,
      },
    };
    return http.post(`${API_BASE}/custom-field/restore/:uuid`, () => HttpResponse.json(body));
  },

  /** Idempotency arm — 404 → CLI re-classifies as already_in_target_state: true. */
  restoreNotFound(): RequestHandler {
    return http.post(`${API_BASE}/custom-field/restore/:uuid`, () =>
      HttpResponse.json(
        { errors: ['Custom field not found or not soft-deleted.'] },
        { status: 404 },
      ),
    );
  },

  restoreForbidden(): RequestHandler {
    return http.post(`${API_BASE}/custom-field/restore/:uuid`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  restoreUnauthorized(): RequestHandler {
    return http.post(`${API_BASE}/custom-field/restore/:uuid`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  restoreServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/custom-field/restore/:uuid`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  restoreRateLimited(): RequestHandler {
    return http.post(
      `${API_BASE}/custom-field/restore/:uuid`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** Per-uuid router for restore — different responses per uuid. */
  restorePerUuidRouter(routes: Record<string, () => Response | HttpResponse>): RequestHandler {
    return http.post(`${API_BASE}/custom-field/restore/:uuid`, ({ params }) => {
      const u = String(params['uuid']);
      const route = routes[u];
      if (route) return route();
      return HttpResponse.json({
        custom_field: {
          uuid: u,
          name: 'Severity',
          custom_fields_types_uuid: '2f7bfe3a-c950-470e-b910-95b4caf5dc4f',
          project_id: 100,
          author_id: 5,
          date_add: '2026-05-10T00:00:00Z',
          priority: 1,
        },
      });
    });
  },
};

export const customFieldsValueHandlers = {
  /** 200 with the supplied uuid echoed in `custom_field_value.uuid`. */
  setScalarOk(uuid = 'cfv-1111-2222-3333'): RequestHandler {
    return http.post(`${API_BASE}/custom-field/add-or-edit-value`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        custom_field_value: {
          uuid,
          value: body['value'],
          task_id: body['task_id'],
          custom_field_uuid: body['custom_field_uuid'],
          date_add: '2026-05-10T00:00:00Z',
          author_id: 1,
        },
      });
    });
  },

  /** 200 with the supplied uuid echoed in `customFieldEnum.uuid`. */
  setEnumOk(uuid = 'cfe-1111-2222-3333'): RequestHandler {
    return http.post(`${API_BASE}/custom-field/add-or-edit-enum-value`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        customFieldEnum: {
          uuid,
          value: body['value'],
          task_id: body['task_id'],
          custom_field_uuid: body['customFieldUuid'],
          date_add: '2026-05-10T00:00:00Z',
          author_id: 1,
        },
      });
    });
  },

  /** Variant: 200 but server omits the wrapped value entirely (defensive shape). */
  setScalarOkEmptyBody(): RequestHandler {
    return http.post(`${API_BASE}/custom-field/add-or-edit-value`, () => HttpResponse.json({}));
  },

  setScalarBadRequest(message = "Field 'value' is invalid."): RequestHandler {
    return http.post(`${API_BASE}/custom-field/add-or-edit-value`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  setScalarNotFound(): RequestHandler {
    return http.post(`${API_BASE}/custom-field/add-or-edit-value`, () =>
      HttpResponse.json({ errors: ['Task or custom field not found.'] }, { status: 404 }),
    );
  },

  setScalarConflict(): RequestHandler {
    return http.post(`${API_BASE}/custom-field/add-or-edit-value`, () =>
      HttpResponse.json(
        { errors: ['Custom field is in the different project than the task.'] },
        { status: 409 },
      ),
    );
  },

  setScalarUnauthorized(): RequestHandler {
    return http.post(`${API_BASE}/custom-field/add-or-edit-value`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  setScalarForbidden(): RequestHandler {
    return http.post(`${API_BASE}/custom-field/add-or-edit-value`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  setScalarRateLimited(): RequestHandler {
    return http.post(`${API_BASE}/custom-field/add-or-edit-value`, () =>
      HttpResponse.json({ errors: ['Too many requests.'] }, { status: 429 }),
    );
  },

  setScalarServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/custom-field/add-or-edit-value`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  setEnumNotFound(message = 'Enum was not found.'): RequestHandler {
    return http.post(`${API_BASE}/custom-field/add-or-edit-enum-value`, () =>
      HttpResponse.json({ errors: [message] }, { status: 404 }),
    );
  },

  /** Per-task body router for batch tests (key by task_id). */
  setScalarPerTaskRouter(map: Record<string, () => Response | Promise<Response>>): RequestHandler {
    return http.post(`${API_BASE}/custom-field/add-or-edit-value`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      const key = String(body['task_id']);
      const fn = map[key];
      if (fn === undefined) {
        return HttpResponse.json({ errors: [`No handler for task_id=${key}`] }, { status: 500 });
      }
      return fn();
    });
  },

  /** 200 success body for DELETE /custom-field/delete-value/{uuid}. */
  deleteOk(): RequestHandler {
    return http.delete(`${API_BASE}/custom-field/delete-value/:uuid`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  deleteNotFound(): RequestHandler {
    return http.delete(`${API_BASE}/custom-field/delete-value/:uuid`, () =>
      HttpResponse.json({ errors: ['Custom field value not found.'] }, { status: 404 }),
    );
  },

  deleteForbidden(): RequestHandler {
    return http.delete(`${API_BASE}/custom-field/delete-value/:uuid`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  deleteServerError(status = 500): RequestHandler {
    return http.delete(`${API_BASE}/custom-field/delete-value/:uuid`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  deletePerUuidRouter(map: Record<string, () => Response | Promise<Response>>): RequestHandler {
    return http.delete(`${API_BASE}/custom-field/delete-value/:uuid`, ({ params }) => {
      const key = String(params['uuid']);
      const fn = map[key];
      if (fn === undefined) {
        return HttpResponse.json({ errors: [`No handler for uuid=${key}`] }, { status: 500 });
      }
      return fn();
    });
  },

  /**
   * `GET /task/{task_id}` returning a `TaskDetail` with the supplied
   * `custom_fields[]` slice — used by `value clear` for the read-back step.
   *
   * Default shape: a task with one custom field set.
   */
  getTaskWithCustomFields(
    taskId: number,
    customFields: Array<Record<string, unknown>>,
  ): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}`, () =>
      HttpResponse.json({
        id: taskId,
        name: `Task #${taskId}`,
        custom_fields: customFields,
      }),
    );
  },

  /** `GET /task/{task_id}` 404 — read-back failure. */
  getTaskNotFound(taskId: number): RequestHandler {
    return http.get(`${API_BASE}/task/${taskId}`, () =>
      HttpResponse.json({ errors: ['Task not found.'] }, { status: 404 }),
    );
  },
};

/**
 * MSW handler factories for the R43 (`custom-fields enum`) endpoint family
 * (spec 0057). Mirrors `customFieldsCrudHandlers` modulo:
 *   - `list`, `add` use `:fieldUuid` (custom-field uuid);
 *   - `rename`, `delete*` use `:enumUuid` (enum-option uuid);
 *   - `delete` is split into `safeDelete*` and `forceDelete*` so tests can
 *     pin which endpoint they expect.
 */
export const customFieldsEnumHandlers = {
  /* ---------------------------------------------------------------------
   *  GET /custom-field-enum/get-for-custom-field/{custom_field_uuid}
   * ------------------------------------------------------------------- */

  listOk(options?: Array<{ uuid: string; value: string }>): RequestHandler {
    const arr = options ?? [
      { uuid: 'enum-1111-2222', value: 'Low' },
      { uuid: 'enum-3333-4444', value: 'Medium' },
      { uuid: 'enum-5555-6666', value: 'High' },
    ];
    return http.get(`${API_BASE}/custom-field-enum/get-for-custom-field/:fieldUuid`, () =>
      HttpResponse.json({ custom_field_enum: arr }),
    );
  },

  listEmpty(): RequestHandler {
    return http.get(`${API_BASE}/custom-field-enum/get-for-custom-field/:fieldUuid`, () =>
      HttpResponse.json({ custom_field_enum: [] }),
    );
  },

  listBadRequest(message = 'Invalid request.'): RequestHandler {
    return http.get(`${API_BASE}/custom-field-enum/get-for-custom-field/:fieldUuid`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  listUnauthorized(): RequestHandler {
    return http.get(`${API_BASE}/custom-field-enum/get-for-custom-field/:fieldUuid`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  listForbidden(): RequestHandler {
    return http.get(`${API_BASE}/custom-field-enum/get-for-custom-field/:fieldUuid`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  listNotFound(): RequestHandler {
    return http.get(`${API_BASE}/custom-field-enum/get-for-custom-field/:fieldUuid`, () =>
      HttpResponse.json({ errors: ['Custom field not found.'] }, { status: 404 }),
    );
  },

  listServerError(status = 500): RequestHandler {
    return http.get(`${API_BASE}/custom-field-enum/get-for-custom-field/:fieldUuid`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  listRateLimited(): RequestHandler {
    return http.get(
      `${API_BASE}/custom-field-enum/get-for-custom-field/:fieldUuid`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /* ---------------------------------------------------------------------
   *  POST /custom-field-enum/create/{custom_field_uuid}
   * ------------------------------------------------------------------- */

  addOk(option?: { uuid: string; value: string }): RequestHandler {
    return http.post(`${API_BASE}/custom-field-enum/create/:fieldUuid`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      const raw = body['value'];
      const value = typeof raw === 'string' ? raw : '';
      return HttpResponse.json({
        custom_field_enum: option ?? { uuid: 'enum-server-generated', value: value || 'Default' },
      });
    });
  },

  addOkWhenBody(
    predicate: (body: unknown, request: Request) => boolean,
    response?: { uuid: string; value: string },
  ): RequestHandler {
    return http.post(`${API_BASE}/custom-field-enum/create/:fieldUuid`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json({
        custom_field_enum: response ?? { uuid: 'enum-server-generated', value: 'X' },
      });
    });
  },

  addBadRequest(message = 'value is required.'): RequestHandler {
    return http.post(`${API_BASE}/custom-field-enum/create/:fieldUuid`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  addUnauthorized(): RequestHandler {
    return http.post(`${API_BASE}/custom-field-enum/create/:fieldUuid`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  addForbidden(): RequestHandler {
    return http.post(`${API_BASE}/custom-field-enum/create/:fieldUuid`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  addNotFound(): RequestHandler {
    return http.post(`${API_BASE}/custom-field-enum/create/:fieldUuid`, () =>
      HttpResponse.json({ errors: ['Custom field not found.'] }, { status: 404 }),
    );
  },

  addServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/custom-field-enum/create/:fieldUuid`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  addRateLimited(): RequestHandler {
    return http.post(
      `${API_BASE}/custom-field-enum/create/:fieldUuid`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /* ---------------------------------------------------------------------
   *  POST /custom-field-enum/change/{custom_field_enum_uuid}
   * ------------------------------------------------------------------- */

  renameOk(option?: { uuid: string; value: string }): RequestHandler {
    return http.post(
      `${API_BASE}/custom-field-enum/change/:enumUuid`,
      async ({ request, params }) => {
        const body = (await request.json()) as Record<string, unknown>;
        const raw = body['value'];
        const value = typeof raw === 'string' ? raw : '';
        return HttpResponse.json({
          custom_field_enum: option ?? {
            uuid: String(params['enumUuid']),
            value: value || 'Default',
          },
        });
      },
    );
  },

  renameOkWhenBody(predicate: (body: unknown, request: Request) => boolean): RequestHandler {
    return http.post(
      `${API_BASE}/custom-field-enum/change/:enumUuid`,
      async ({ request, params }) => {
        const body: unknown = await request.clone().json();
        if (!predicate(body, request)) {
          return HttpResponse.json(
            { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
            { status: 500 },
          );
        }
        return HttpResponse.json({
          custom_field_enum: { uuid: String(params['enumUuid']), value: 'New Value' },
        });
      },
    );
  },

  renameBadRequest(message = 'Invalid request body.'): RequestHandler {
    return http.post(`${API_BASE}/custom-field-enum/change/:enumUuid`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  renameUnauthorized(): RequestHandler {
    return http.post(`${API_BASE}/custom-field-enum/change/:enumUuid`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  renameForbidden(): RequestHandler {
    return http.post(`${API_BASE}/custom-field-enum/change/:enumUuid`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  renameNotFound(): RequestHandler {
    return http.post(`${API_BASE}/custom-field-enum/change/:enumUuid`, () =>
      HttpResponse.json({ errors: ['Enum option not found.'] }, { status: 404 }),
    );
  },

  renameServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/custom-field-enum/change/:enumUuid`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  renameRateLimited(): RequestHandler {
    return http.post(
      `${API_BASE}/custom-field-enum/change/:enumUuid`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /* ---------------------------------------------------------------------
   *  DELETE /custom-field-enum/delete/{custom_field_enum_uuid}      (safe)
   *  DELETE /custom-field-enum/force-delete/{custom_field_enum_uuid} (cascading)
   * ------------------------------------------------------------------- */

  safeDeleteOk(): RequestHandler {
    return http.delete(`${API_BASE}/custom-field-enum/delete/:enumUuid`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  safeDeleteNotFound(): RequestHandler {
    return http.delete(`${API_BASE}/custom-field-enum/delete/:enumUuid`, () =>
      HttpResponse.json({ errors: ['Not found.'] }, { status: 404 }),
    );
  },

  /** Server refuses safe delete because the option is referenced. */
  safeDeleteInUse(message = 'Enum option is in use by tasks.'): RequestHandler {
    return http.delete(`${API_BASE}/custom-field-enum/delete/:enumUuid`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  safeDeleteForbidden(): RequestHandler {
    return http.delete(`${API_BASE}/custom-field-enum/delete/:enumUuid`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  safeDeleteUnauthorized(): RequestHandler {
    return http.delete(`${API_BASE}/custom-field-enum/delete/:enumUuid`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  safeDeleteServerError(status = 500): RequestHandler {
    return http.delete(`${API_BASE}/custom-field-enum/delete/:enumUuid`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  safeDeleteRateLimited(): RequestHandler {
    return http.delete(
      `${API_BASE}/custom-field-enum/delete/:enumUuid`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** Per-uuid router — different responses per uuid for safe delete. */
  safeDeletePerUuidRouter(routes: Record<string, () => Response | HttpResponse>): RequestHandler {
    return http.delete(`${API_BASE}/custom-field-enum/delete/:enumUuid`, ({ params }) => {
      const u = String(params['enumUuid']);
      const route = routes[u];
      if (route) return route();
      return HttpResponse.json({ result: 'success' });
    });
  },

  forceDeleteOk(): RequestHandler {
    return http.delete(`${API_BASE}/custom-field-enum/force-delete/:enumUuid`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  forceDeleteNotFound(): RequestHandler {
    return http.delete(`${API_BASE}/custom-field-enum/force-delete/:enumUuid`, () =>
      HttpResponse.json({ errors: ['Not found.'] }, { status: 404 }),
    );
  },

  forceDeleteForbidden(): RequestHandler {
    return http.delete(`${API_BASE}/custom-field-enum/force-delete/:enumUuid`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  forceDeleteServerError(status = 500): RequestHandler {
    return http.delete(`${API_BASE}/custom-field-enum/force-delete/:enumUuid`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  forceDeleteRateLimited(): RequestHandler {
    return http.delete(
      `${API_BASE}/custom-field-enum/force-delete/:enumUuid`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },
};

/**
 * MSW handler factories for the R44 (`notes`) endpoint family (spec 0058).
 *
 * Endpoints:
 *   - `POST   /project/{project_id}/note`  (create)
 *   - `GET    /note/{note_id}`             (show)
 *   - `POST   /note/{note_id}`             (edit — verb is POST per yaml :4625)
 *   - `DELETE /note/{note_id}`             (delete — quirk: returns Note body)
 */
export const notesHandlers = {
  /* ---------------------------------------------------------------------
   *  POST /project/{project_id}/note (create)
   * ------------------------------------------------------------------- */

  createOk(projectId: number, note?: Record<string, unknown>): RequestHandler {
    const body = note ?? {
      id: 1234,
      name: 'Meeting minutes',
      content: 'Body',
      date_add: '2026-05-10T00:00:00Z',
      date_edited_at: '2026-05-10T00:00:00Z',
      author: { id: 5, fullname: 'Jane Doe' },
      project: { id: projectId, name: 'Project X' },
    };
    return http.post(`${API_BASE}/project/${projectId}/note`, () => HttpResponse.json(body));
  },

  createOkWhenBody(
    projectId: number,
    predicate: (body: unknown, request: Request) => boolean,
    response?: Record<string, unknown>,
  ): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/note`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json(
        response ?? {
          id: 1234,
          name: 'From-predicate',
          content: 'Body',
          date_add: '2026-05-10T00:00:00Z',
          date_edited_at: '2026-05-10T00:00:00Z',
        },
      );
    });
  },

  createBadRequest(projectId: number, message = 'Invalid request body.'): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/note`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  createUnauthorized(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/note`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  createForbidden(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/note`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  createNotFound(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/note`, () =>
      HttpResponse.json({ errors: ['Project not found.'] }, { status: 404 }),
    );
  },

  createServerError(projectId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/note`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  createRateLimited(projectId: number): RequestHandler {
    return http.post(
      `${API_BASE}/project/${projectId}/note`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  createNetworkError(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/note`, () => HttpResponse.error());
  },

  /* ---------------------------------------------------------------------
   *  GET /note/{note_id} (show)
   * ------------------------------------------------------------------- */

  showOk(note?: Record<string, unknown>): RequestHandler {
    const body = note ?? {
      id: 1234,
      name: 'Meeting minutes',
      content: 'Detailed body',
      date_add: '2026-05-10T00:00:00Z',
      date_edited_at: '2026-05-10T00:00:00Z',
      author: { id: 5, fullname: 'Jane Doe' },
      project: { id: 100, name: 'Project X' },
    };
    return http.get(`${API_BASE}/note/:noteId`, () => HttpResponse.json(body));
  },

  showUnauthorized(): RequestHandler {
    return http.get(`${API_BASE}/note/:noteId`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  showForbidden(): RequestHandler {
    return http.get(`${API_BASE}/note/:noteId`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  showNotFound(): RequestHandler {
    return http.get(`${API_BASE}/note/:noteId`, () =>
      HttpResponse.json({ errors: ['Note not found.'] }, { status: 404 }),
    );
  },

  showServerError(status = 500): RequestHandler {
    return http.get(`${API_BASE}/note/:noteId`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  showRateLimited(): RequestHandler {
    return http.get(
      `${API_BASE}/note/:noteId`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  showNetworkError(): RequestHandler {
    return http.get(`${API_BASE}/note/:noteId`, () => HttpResponse.error());
  },

  /* ---------------------------------------------------------------------
   *  POST /note/{note_id} (edit)
   * ------------------------------------------------------------------- */

  editOk(note?: Record<string, unknown>): RequestHandler {
    const body = note ?? {
      id: 1234,
      name: 'Edited title',
      content: 'Edited body',
      date_add: '2026-05-10T00:00:00Z',
      date_edited_at: '2026-05-10T01:00:00Z',
    };
    return http.post(`${API_BASE}/note/:noteId`, () => HttpResponse.json(body));
  },

  editOkWhenBody(
    predicate: (body: unknown, request: Request) => boolean,
    response?: Record<string, unknown>,
  ): RequestHandler {
    return http.post(`${API_BASE}/note/:noteId`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json(
        response ?? {
          id: 1234,
          name: 'Edited title',
          content: 'Edited body',
          date_add: '2026-05-10T00:00:00Z',
          date_edited_at: '2026-05-10T01:00:00Z',
        },
      );
    });
  },

  editBadRequest(message = 'Invalid edit body.'): RequestHandler {
    return http.post(`${API_BASE}/note/:noteId`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  editForbidden(): RequestHandler {
    return http.post(`${API_BASE}/note/:noteId`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  editNotFound(): RequestHandler {
    return http.post(`${API_BASE}/note/:noteId`, () =>
      HttpResponse.json({ errors: ['Note not found.'] }, { status: 404 }),
    );
  },

  editServerError(status = 500): RequestHandler {
    return http.post(`${API_BASE}/note/:noteId`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  editRateLimited(): RequestHandler {
    return http.post(
      `${API_BASE}/note/:noteId`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  editNetworkError(): RequestHandler {
    return http.post(`${API_BASE}/note/:noteId`, () => HttpResponse.error());
  },

  /* ---------------------------------------------------------------------
   *  DELETE /note/{note_id} (quirk: returns Note body, not SuccessResponse)
   * ------------------------------------------------------------------- */

  deleteOk(note?: Record<string, unknown>): RequestHandler {
    const body = note ?? {
      id: 1234,
      name: 'Meeting minutes',
      content: 'Body before delete',
      date_add: '2026-05-10T00:00:00Z',
      date_edited_at: '2026-05-10T01:00:00Z',
    };
    return http.delete(`${API_BASE}/note/:noteId`, () => HttpResponse.json(body));
  },

  deleteForbidden(): RequestHandler {
    return http.delete(`${API_BASE}/note/:noteId`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  deleteNotFound(): RequestHandler {
    return http.delete(`${API_BASE}/note/:noteId`, () =>
      HttpResponse.json({ errors: ['Note not found.'] }, { status: 404 }),
    );
  },

  deleteUnauthorized(): RequestHandler {
    return http.delete(`${API_BASE}/note/:noteId`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  deleteServerError(status = 500): RequestHandler {
    return http.delete(`${API_BASE}/note/:noteId`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  deleteRateLimited(): RequestHandler {
    return http.delete(
      `${API_BASE}/note/:noteId`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  deleteNetworkError(): RequestHandler {
    return http.delete(`${API_BASE}/note/:noteId`, () => HttpResponse.error());
  },

  /**
   * Per-id status dispatcher for the multi-id batch test (one mid-stream
   * 500 alongside other 200s). Mirrors the pattern used by
   * `customFieldsCrudHandlers.deleteByIdMatrix`.
   */
  deleteByIdMatrix(matrix: Record<number, 200 | 401 | 403 | 404 | 500>): RequestHandler {
    return http.delete(`${API_BASE}/note/:noteId`, ({ params }) => {
      const idRaw = (params as Record<string, string>)['noteId'];
      const idNum = Number(idRaw);
      const status = matrix[idNum];
      if (status === undefined || status === 200) {
        return HttpResponse.json({ id: idNum, name: `Note ${idNum}`, content: 'x' });
      }
      return HttpResponse.json({ errors: [`Status ${status} for note ${idNum}`] }, { status });
    });
  },
};

/**
 * MSW handler factories for the R44 (`pins`) endpoint family (spec 0058).
 *
 * Endpoints:
 *   - `GET    /project/{project_id}/pinned-items`  (list)
 *   - `POST   /project/{project_id}/pinned-items`  (add)
 *   - `DELETE /pinned-item/{pinned_item_id}`       (remove)
 */
export const pinsHandlers = {
  /* ---------------------------------------------------------------------
   *  GET /project/{project_id}/pinned-items (list)
   * ------------------------------------------------------------------- */

  listOk(projectId: number, items?: Array<Record<string, unknown>>): RequestHandler {
    const body = items ?? [
      { id: 1, link: 'https://example.com/spec', title: 'Spec doc' },
      { id: 2, link: 'https://example.com/wiki', title: 'Wiki' },
    ];
    return http.get(`${API_BASE}/project/${projectId}/pinned-items`, () => HttpResponse.json(body));
  },

  listEmpty(projectId: number): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}/pinned-items`, () => HttpResponse.json([]));
  },

  listUnauthorized(projectId: number): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}/pinned-items`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  listForbidden(projectId: number): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}/pinned-items`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  listNotFound(projectId: number): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}/pinned-items`, () =>
      HttpResponse.json({ errors: ['Project not found.'] }, { status: 404 }),
    );
  },

  listServerError(projectId: number, status = 500): RequestHandler {
    return http.get(`${API_BASE}/project/${projectId}/pinned-items`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  listRateLimited(projectId: number): RequestHandler {
    return http.get(
      `${API_BASE}/project/${projectId}/pinned-items`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /* ---------------------------------------------------------------------
   *  POST /project/{project_id}/pinned-items (add)
   * ------------------------------------------------------------------- */

  addOk(projectId: number, pin?: Record<string, unknown>): RequestHandler {
    const body = pin ?? { id: 99, link: 'https://example.com/spec', title: 'Spec doc' };
    return http.post(`${API_BASE}/project/${projectId}/pinned-items`, () =>
      HttpResponse.json(body),
    );
  },

  addOkWhenBody(
    projectId: number,
    predicate: (body: unknown, request: Request) => boolean,
    response?: Record<string, unknown>,
  ): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/pinned-items`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!predicate(body, request)) {
        return HttpResponse.json(
          { errors: [`Body did not match predicate: ${JSON.stringify(body)}`] },
          { status: 500 },
        );
      }
      return HttpResponse.json(
        response ?? { id: 99, link: 'https://example.com/spec', title: 'Spec doc' },
      );
    });
  },

  addBadRequest(projectId: number, message = 'Invalid pin body.'): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/pinned-items`, () =>
      HttpResponse.json({ errors: [message] }, { status: 400 }),
    );
  },

  addForbidden(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/pinned-items`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  addNotFound(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/pinned-items`, () =>
      HttpResponse.json({ errors: ['Project not found.'] }, { status: 404 }),
    );
  },

  addServerError(projectId: number, status = 500): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/pinned-items`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  addRateLimited(projectId: number): RequestHandler {
    return http.post(
      `${API_BASE}/project/${projectId}/pinned-items`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  addNetworkError(projectId: number): RequestHandler {
    return http.post(`${API_BASE}/project/${projectId}/pinned-items`, () => HttpResponse.error());
  },

  /* ---------------------------------------------------------------------
   *  DELETE /pinned-item/{pinned_item_id} (remove)
   * ------------------------------------------------------------------- */

  removeOk(): RequestHandler {
    return http.delete(`${API_BASE}/pinned-item/:pinId`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  removeUnauthorized(): RequestHandler {
    return http.delete(`${API_BASE}/pinned-item/:pinId`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  removeForbidden(): RequestHandler {
    return http.delete(`${API_BASE}/pinned-item/:pinId`, () =>
      HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
    );
  },

  removeNotFound(): RequestHandler {
    return http.delete(`${API_BASE}/pinned-item/:pinId`, () =>
      HttpResponse.json({ errors: ['Pinned item not found.'] }, { status: 404 }),
    );
  },

  removeServerError(status = 500): RequestHandler {
    return http.delete(`${API_BASE}/pinned-item/:pinId`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  removeRateLimited(): RequestHandler {
    return http.delete(
      `${API_BASE}/pinned-item/:pinId`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  removeByIdMatrix(matrix: Record<number, 200 | 401 | 403 | 404 | 500>): RequestHandler {
    return http.delete(`${API_BASE}/pinned-item/:pinId`, ({ params }) => {
      const idRaw = (params as Record<string, string>)['pinId'];
      const idNum = Number(idRaw);
      const status = matrix[idNum];
      if (status === undefined || status === 200) {
        return HttpResponse.json({ result: 'success' });
      }
      return HttpResponse.json({ errors: [`Status ${status} for pin ${idNum}`] }, { status });
    });
  },
};

/**
 * MSW handlers for `freelo comments delete` (M01, spec 0061).
 *
 * One endpoint: `DELETE /comment/{comment_id}` (yaml :3203-3232).
 *
 * Mirrors `tasksDeleteHandlers` with two endpoint-specific additions:
 *   - `deleteWindowExpired` — the 400 the API returns once the 15-minute
 *     post-time deletion window has closed (yaml :3229-3230).
 *   - `deleteMatrix` — per-id status map for mixed-batch tests.
 *
 * Note that `deleteNotFound` here is an **error** path, not the idempotent
 * already-deleted path it is for tasks (spec 0061 §5.1 / decision 1).
 */
export const commentsDeleteHandlers = {
  /** `DELETE /comment/{id}` — 200 success. */
  deleteOk(commentId: number): RequestHandler {
    return http.delete(`${API_BASE}/comment/${commentId}`, () =>
      HttpResponse.json({ result: 'success' }),
    );
  },

  /**
   * `DELETE /comment/{id}` — 400, the 15-minute deletion window has expired.
   * The command layer rewrites the message and hint (spec 0061 §5.2).
   */
  deleteWindowExpired(commentId: number): RequestHandler {
    return http.delete(`${API_BASE}/comment/${commentId}`, () =>
      HttpResponse.json({ errors: ['Comment is too old to be deleted.'] }, { status: 400 }),
    );
  },

  /**
   * `DELETE /comment/{id}` — 404. Comment missing **or** not authored by the
   * caller; the API deliberately doesn't distinguish (yaml :3215). Unlike
   * `tasks delete`, the command surfaces this as an error, never as success.
   */
  deleteNotFound(commentId: number): RequestHandler {
    return http.delete(`${API_BASE}/comment/${commentId}`, () =>
      HttpResponse.json({ errors: ['Comment not found.'] }, { status: 404 }),
    );
  },

  /** `DELETE /comment/{id}` — 401. */
  deleteUnauthorized(commentId: number): RequestHandler {
    return http.delete(`${API_BASE}/comment/${commentId}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `DELETE /comment/{id}` — 403 (defensive; yaml says ACL failures are 404). */
  deleteForbidden(commentId: number): RequestHandler {
    return http.delete(`${API_BASE}/comment/${commentId}`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  /** `DELETE /comment/{id}` — 5xx. */
  deleteServerError(commentId: number, status = 500): RequestHandler {
    return http.delete(`${API_BASE}/comment/${commentId}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** `DELETE /comment/{id}` — 429 (Retry-After: 0). */
  deleteRateLimited(commentId: number): RequestHandler {
    return http.delete(
      `${API_BASE}/comment/${commentId}`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** `DELETE /comment/{id}` — connection-closed (network error). */
  deleteNetworkError(commentId: number): RequestHandler {
    return http.delete(`${API_BASE}/comment/${commentId}`, () => HttpResponse.error());
  },

  /**
   * Per-id status matrix for mixed-batch tests: `{ [commentId]: httpStatus }`.
   * Ids absent from the map (or mapped to 200) succeed. Mirrors the
   * `pinned-item` matrix handler at the top of this section.
   */
  deleteMatrix(matrix: Readonly<Record<number, number>>): RequestHandler {
    return http.delete(`${API_BASE}/comment/:commentId`, ({ params }) => {
      const idRaw = (params as Record<string, string>)['commentId'];
      const idNum = Number(idRaw);
      const status = matrix[idNum];
      if (status === undefined || status === 200) {
        return HttpResponse.json({ result: 'success' });
      }
      return HttpResponse.json({ errors: [`Status ${status} for comment ${idNum}`] }, { status });
    });
  },
};

/* ---------------------------------------------------------------------------
 *  M07 — `freelo files delete` (spec 0064)
 *
 *  `DELETE /file/{file_uuid}` (yaml :4492-4521, `deleteDocOrFileByUuid`).
 *  Direct analogue of `commentsDeleteHandlers` above, keyed on UUID strings
 *  rather than numeric ids.
 *
 *  There is deliberately **no 400 handler**: the endpoint documents only 200
 *  and 404 (spec 0064 §3), so a 400 fixture would be inventing API behavior.
 * ------------------------------------------------------------------------- */

export const filesDeleteHandlers = {
  /** `DELETE /file/{uuid}` — 200 success. */
  deleteOk(uuid: string): RequestHandler {
    return http.delete(`${API_BASE}/file/${uuid}`, () => HttpResponse.json({ result: 'success' }));
  },

  /**
   * `DELETE /file/{uuid}` — 404. Resource missing **or** invisible to the
   * caller; the API deliberately doesn't distinguish (yaml :4504). Unlike
   * `tasks delete`, the command surfaces this as an error, never as an
   * idempotent success (spec 0064 §5.1).
   */
  deleteNotFound(uuid: string): RequestHandler {
    return http.delete(`${API_BASE}/file/${uuid}`, () =>
      HttpResponse.json({ errors: ['File not found.'] }, { status: 404 }),
    );
  },

  /** `DELETE /file/{uuid}` — 401. */
  deleteUnauthorized(uuid: string): RequestHandler {
    return http.delete(`${API_BASE}/file/${uuid}`, () =>
      HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
    );
  },

  /** `DELETE /file/{uuid}` — 403 (defensive; yaml says ACL failures are 404). */
  deleteForbidden(uuid: string): RequestHandler {
    return http.delete(`${API_BASE}/file/${uuid}`, () =>
      HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
    );
  },

  /** `DELETE /file/{uuid}` — 5xx. */
  deleteServerError(uuid: string, status = 500): RequestHandler {
    return http.delete(`${API_BASE}/file/${uuid}`, () =>
      HttpResponse.json({ errors: ['Internal server error.'] }, { status }),
    );
  },

  /** `DELETE /file/{uuid}` — 429 (Retry-After: 0). */
  deleteRateLimited(uuid: string): RequestHandler {
    return http.delete(
      `${API_BASE}/file/${uuid}`,
      () =>
        new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        }),
    );
  },

  /** `DELETE /file/{uuid}` — connection-closed (network error). */
  deleteNetworkError(uuid: string): RequestHandler {
    return http.delete(`${API_BASE}/file/${uuid}`, () => HttpResponse.error());
  },

  /**
   * Per-uuid status matrix for mixed-batch tests: `{ [uuid]: httpStatus }`.
   * UUIDs absent from the map (or mapped to 200) succeed. Mirrors
   * `commentsDeleteHandlers.deleteMatrix`.
   */
  deleteMatrix(matrix: Readonly<Record<string, number>>): RequestHandler {
    return http.delete(`${API_BASE}/file/:fileUuid`, ({ params }) => {
      const uuid = (params as Record<string, string>)['fileUuid'] ?? '';
      const status = matrix[uuid];
      if (status === undefined || status === 200) {
        return HttpResponse.json({ result: 'success' });
      }
      return HttpResponse.json({ errors: [`Status ${status} for file ${uuid}`] }, { status });
    });
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
