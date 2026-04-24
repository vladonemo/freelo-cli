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
 * Pre-configured MSW server. Start in tests with:
 *
 *   beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
 *   afterEach(() => server.resetHandlers());
 *   afterAll(() => server.close());
 */
export const server = setupServer();
