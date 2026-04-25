import { describe, expect, it } from 'vitest';
import { buildEnvelope, buildErrorEnvelope } from '../../src/ui/envelope.js';
import { FreeloApiError } from '../../src/errors/freelo-api-error.js';
import { ConfigError } from '../../src/errors/config-error.js';
import { NetworkError } from '../../src/errors/network-error.js';

const SCHEMA_PATTERN = /^freelo\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\/v\d+$/;

describe('buildEnvelope — schema field contract', () => {
  it('includes schema in the output envelope', () => {
    const env = buildEnvelope({ schema: 'freelo.auth.whoami/v1', data: { user_id: 1 } });
    expect(env.schema).toBe('freelo.auth.whoami/v1');
  });

  it('schema matches the versioned naming pattern freelo.<resource>.<op>/v<n>', () => {
    const schemas = [
      'freelo.auth.login/v1',
      'freelo.auth.logout/v1',
      'freelo.auth.whoami/v1',
      'freelo.error/v1',
    ] as const;
    for (const s of schemas) {
      expect(SCHEMA_PATTERN.test(s), `${s} should match pattern`).toBe(true);
    }
  });

  it('single-record data is placed directly at data (not wrapped in array)', () => {
    const data = { profile: 'default', user_id: 42 };
    const env = buildEnvelope({ schema: 'freelo.auth.whoami/v1', data });
    expect(env.data).toBe(data);
    expect(Array.isArray(env.data)).toBe(false);
  });
});

describe('buildEnvelope — optional fields omitted when absent', () => {
  it('omits paging when not provided', () => {
    const env = buildEnvelope({ schema: 'freelo.auth.whoami/v1', data: {} });
    expect('paging' in env).toBe(false);
  });

  it('omits rate_limit when not provided', () => {
    const env = buildEnvelope({ schema: 'freelo.auth.whoami/v1', data: {} });
    expect('rate_limit' in env).toBe(false);
  });

  it('omits request_id when not provided', () => {
    const env = buildEnvelope({ schema: 'freelo.auth.whoami/v1', data: {} });
    expect('request_id' in env).toBe(false);
  });

  it('omits notice when not provided', () => {
    const env = buildEnvelope({ schema: 'freelo.auth.whoami/v1', data: {} });
    expect('notice' in env).toBe(false);
  });
});

describe('buildEnvelope — optional fields included when provided', () => {
  it('includes rate_limit when provided', () => {
    const env = buildEnvelope({
      schema: 'freelo.auth.whoami/v1',
      data: {},
      rateLimit: { remaining: 99, reset_at: null },
    });
    expect(env.rate_limit).toEqual({ remaining: 99, reset_at: null });
  });

  it('includes request_id when provided', () => {
    const env = buildEnvelope({
      schema: 'freelo.auth.whoami/v1',
      data: {},
      requestId: 'req-123',
    });
    expect(env.request_id).toBe('req-123');
  });

  it('includes notice when provided', () => {
    const env = buildEnvelope({
      schema: 'freelo.auth.login/v1',
      data: {},
      notice: "Replaced token for profile 'default'.",
    });
    expect(env.notice).toBe("Replaced token for profile 'default'.");
  });

  it('includes paging when provided', () => {
    const env = buildEnvelope({
      schema: 'freelo.auth.whoami/v1',
      data: {},
      paging: { page: 1, per_page: 20, total: 100, next_cursor: null },
    });
    expect(env.paging).toEqual({ page: 1, per_page: 20, total: 100, next_cursor: null });
  });
});

describe('buildErrorEnvelope', () => {
  it('produces a freelo.error/v1 envelope', () => {
    const err = new FreeloApiError('Invalid credentials.', 'AUTH_EXPIRED');
    const env = buildErrorEnvelope(err);
    expect(env.schema).toBe('freelo.error/v1');
  });

  it('includes error.code from the error', () => {
    const err = new FreeloApiError('Invalid credentials.', 'AUTH_EXPIRED');
    const env = buildErrorEnvelope(err);
    expect(env.error.code).toBe('AUTH_EXPIRED');
  });

  it('includes error.retryable from the error', () => {
    const networkErr = new NetworkError('DNS fail'); // retryable: true
    const env = buildErrorEnvelope(networkErr);
    expect(env.error.retryable).toBe(true);
  });

  it('includes error.http_status when present', () => {
    const err = FreeloApiError.fromResponse({ status: 401 });
    const env = buildErrorEnvelope(err);
    expect(env.error.http_status).toBe(401);
  });

  it('has null http_status when httpStatus is absent', () => {
    const err = new NetworkError('DNS fail');
    const env = buildErrorEnvelope(err);
    expect(env.error.http_status).toBeNull();
  });

  it('includes hint_next when present', () => {
    const err = new ConfigError('no token', { kind: 'missing-token', profile: 'default' });
    const env = buildErrorEnvelope(err);
    expect(typeof env.error.hint_next).toBe('string');
    expect(env.error.hint_next!.length).toBeGreaterThan(0);
  });

  it('has null hint_next when no hint is set', () => {
    const err = new NetworkError('DNS fail');
    const env = buildErrorEnvelope(err);
    expect(env.error.hint_next).toBeNull();
  });

  it('always has docs_url: null', () => {
    const err = new NetworkError('DNS fail');
    const env = buildErrorEnvelope(err);
    expect(env.error.docs_url).toBeNull();
  });

  it('includes errors array when non-empty', () => {
    const err = new FreeloApiError('API error', 'AUTH_EXPIRED', {
      errors: ['Invalid token'],
    });
    const env = buildErrorEnvelope(err);
    expect(env.error.errors).toEqual(['Invalid token']);
  });

  it('omits errors field when the array is empty', () => {
    const err = new FreeloApiError('API error', 'AUTH_EXPIRED', { errors: [] });
    const env = buildErrorEnvelope(err);
    expect('errors' in env.error).toBe(false);
  });
});
