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
 * Pre-configured MSW server. Start in tests with:
 *
 *   beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
 *   afterEach(() => server.resetHandlers());
 *   afterAll(() => server.close());
 */
export const server = setupServer();
