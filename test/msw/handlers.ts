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
 * Pre-configured MSW server. Start in tests with:
 *
 *   beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
 *   afterEach(() => server.resetHandlers());
 *   afterAll(() => server.close());
 */
export const server = setupServer();
