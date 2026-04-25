import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server, API_BASE, usersMeHandlers } from '../msw/handlers.js';
import { HttpClient } from '../../src/api/client.js';
import { getUsersMe } from '../../src/api/users.js';
import { FreeloApiError } from '../../src/errors/freelo-api-error.js';
import { NetworkError } from '../../src/errors/network-error.js';
import { VERSION } from '../../src/lib/version.js';

const TEST_OPTS = {
  email: 'test@example.cz',
  apiKey: 'sk-test-key',
  apiBaseUrl: API_BASE,
  userAgent: `freelo-cli/${VERSION} (+https://github.com/vladonemo/freelo-cli)`,
};

function makeClient() {
  return new HttpClient(TEST_OPTS);
}

describe('getUsersMe — happy path', () => {
  beforeEach(() => {
    server.use(usersMeHandlers.ok());
  });

  it('returns the parsed user with id on a 200 response', async () => {
    const { user } = await getUsersMe(makeClient(), {});
    expect(user.id).toBe(12345);
  });

  it('returns the raw ApiResponse for rate-limit metadata', async () => {
    const { raw } = await getUsersMe(makeClient(), {});
    expect(raw.rateLimit).toBeDefined();
  });
});

describe('getUsersMe — extended fixture', () => {
  beforeEach(() => {
    server.use(usersMeHandlers.okExtended());
  });

  it('preserves passthrough fields like email and fullname', async () => {
    const { user } = await getUsersMe(makeClient(), {});
    expect((user as Record<string, unknown>)['email']).toBe('jane@example.cz');
    expect((user as Record<string, unknown>)['fullname']).toBe('Jane Doe');
  });
});

describe('getUsersMe — 401 object-form errors', () => {
  beforeEach(() => {
    server.use(usersMeHandlers.unauthorized());
  });

  it('throws FreeloApiError with AUTH_EXPIRED on 401 (object-form errors)', async () => {
    try {
      await getUsersMe(makeClient(), {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FreeloApiError);
      expect((err as FreeloApiError).code).toBe('AUTH_EXPIRED');
    }
  });

  it('normalizes object-form errors to string[] on 401', async () => {
    try {
      await getUsersMe(makeClient(), {});
    } catch (err) {
      expect((err as FreeloApiError).errors).toEqual(['Invalid token']);
    }
  });
});

describe('getUsersMe — 401 global string-array form', () => {
  beforeEach(() => {
    server.use(usersMeHandlers.unauthorizedGlobal());
  });

  it('throws FreeloApiError with AUTH_EXPIRED on 401 (string-array errors)', async () => {
    try {
      await getUsersMe(makeClient(), {});
    } catch (err) {
      expect(err).toBeInstanceOf(FreeloApiError);
      expect((err as FreeloApiError).code).toBe('AUTH_EXPIRED');
    }
  });

  it('normalizes string-array errors to string[] on 401', async () => {
    try {
      await getUsersMe(makeClient(), {});
    } catch (err) {
      expect((err as FreeloApiError).errors).toEqual(['Invalid token']);
    }
  });
});

describe('getUsersMe — malformed 2xx body', () => {
  beforeEach(() => {
    server.use(usersMeHandlers.malformed());
  });

  it('throws FreeloApiError with VALIDATION_ERROR when 2xx body fails zod', async () => {
    try {
      await getUsersMe(makeClient(), {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FreeloApiError);
      expect((err as FreeloApiError).code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('getUsersMe — 5xx server error', () => {
  beforeEach(() => {
    server.use(usersMeHandlers.serverError(500));
  });

  it('throws FreeloApiError with retryable true on 500', async () => {
    try {
      await getUsersMe(makeClient(), {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FreeloApiError);
      expect((err as FreeloApiError).retryable).toBe(true);
    }
  });
});

describe('getUsersMe — network error', () => {
  beforeEach(() => {
    server.use(http.get(`${API_BASE}/users/me`, () => HttpResponse.error()));
  });

  it('throws NetworkError when the network call fails', async () => {
    await expect(getUsersMe(makeClient(), {})).rejects.toThrow(NetworkError);
  });
});
