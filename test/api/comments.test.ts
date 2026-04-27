/**
 * Unit tests for `src/api/comments.ts` (R16 spec 0027 §4.2 / §4.3).
 *
 * Two surfaces:
 *   - `commentMatchesSince` — pure function, no I/O.
 *   - `getAllComments` — URL building. Verified via a fake `HttpClient` that
 *     captures the request path; no MSW needed.
 */

import { describe, expect, it, vi } from 'vitest';
import { commentMatchesSince, getAllComments } from '../../src/api/comments.js';
import { type HttpClient } from '../../src/api/client.js';

// ---------------------------------------------------------------------------
//  commentMatchesSince
// ---------------------------------------------------------------------------

describe('commentMatchesSince', () => {
  const cutoff = Date.parse('2026-04-15T00:00:00Z');

  it('returns true when date_add is after cutoff', () => {
    expect(commentMatchesSince({ date_add: '2026-04-25T10:00:00Z' }, cutoff, 'date_add')).toBe(
      true,
    );
  });

  it('returns false when date_add is strictly before cutoff', () => {
    expect(commentMatchesSince({ date_add: '2026-04-10T10:00:00Z' }, cutoff, 'date_add')).toBe(
      false,
    );
  });

  it('returns true when date_add equals cutoff (inclusive >=)', () => {
    expect(commentMatchesSince({ date_add: '2026-04-15T00:00:00Z' }, cutoff, 'date_add')).toBe(
      true,
    );
  });

  it('uses date_edited_at when field is "date_edited_at"', () => {
    // date_add is OLD but date_edited_at is RECENT → should match
    const c = {
      date_add: '2026-03-01T00:00:00Z',
      date_edited_at: '2026-04-25T00:00:00Z',
    };
    expect(commentMatchesSince(c, cutoff, 'date_edited_at')).toBe(true);
  });

  it('falls back to date_add when date_edited_at is missing on field=date_edited_at', () => {
    const c = { date_add: '2026-04-25T00:00:00Z' };
    expect(commentMatchesSince(c, cutoff, 'date_edited_at')).toBe(true);
  });

  it('falls back to date_add when date_edited_at is null on field=date_edited_at', () => {
    const c = { date_add: '2026-04-25T00:00:00Z', date_edited_at: null };
    expect(commentMatchesSince(c, cutoff, 'date_edited_at')).toBe(true);
  });

  it('tolerates malformed dates by including (returns true)', () => {
    expect(commentMatchesSince({ date_add: 'not-a-date' }, cutoff, 'date_add')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  getAllComments — URL building
// ---------------------------------------------------------------------------

type RequestArgs = Parameters<HttpClient['request']>[0];

function makeFakeClient(): {
  client: HttpClient;
  capture: { last?: RequestArgs };
} {
  const capture: { last?: RequestArgs } = {};
  const client = {
    request: vi.fn((args: RequestArgs) => {
      capture.last = args;
      // Return a stub paginated response shape so normalizePaginated is happy.
      return Promise.resolve({
        data: {
          total: 0,
          count: 0,
          page: 0,
          per_page: 25,
          data: { comments: [] },
        },
        rateLimit: { remaining: null, resetAt: null },
        requestId: undefined,
      });
    }),
  } as unknown as HttpClient;
  return { client, capture };
}

describe('getAllComments — URL building', () => {
  it('builds `/all-comments?p=0` with no filters', async () => {
    const { client, capture } = makeFakeClient();
    await getAllComments(client, { page: 0, filters: {} });
    expect(capture.last?.path).toBe('/all-comments?p=0');
  });

  it('encodes projects_ids[] for repeated --project ids (bracketed array convention)', async () => {
    const { client, capture } = makeFakeClient();
    await getAllComments(client, {
      page: 0,
      filters: { projects: [11, 22] },
    });
    const path = capture.last?.path ?? '';
    expect(path).toContain('p=0');
    expect(path).toContain('projects_ids%5B%5D=11');
    expect(path).toContain('projects_ids%5B%5D=22');
  });

  it('encodes type, order_by, order', async () => {
    const { client, capture } = makeFakeClient();
    await getAllComments(client, {
      page: 0,
      filters: { type: 'task', orderBy: 'date_edited_at', order: 'asc' },
    });
    const path = capture.last?.path ?? '';
    expect(path).toContain('type=task');
    expect(path).toContain('order_by=date_edited_at');
    expect(path).toContain('order=asc');
  });

  it('uses higher page index correctly (p=2)', async () => {
    const { client, capture } = makeFakeClient();
    await getAllComments(client, { page: 2, filters: {} });
    expect(capture.last?.path).toContain('p=2');
  });

  it('passes through requestId when provided', async () => {
    const { client, capture } = makeFakeClient();
    await getAllComments(client, {
      page: 0,
      filters: {},
      requestId: 'abc-123',
    });
    expect(capture.last?.requestId).toBe('abc-123');
  });

  it('passes a z.unknown() schema (raw response is normalized in the wrapper, not by zod)', async () => {
    const { client, capture } = makeFakeClient();
    await getAllComments(client, { page: 0, filters: {} });
    // The schema must be permissive — `normalizePaginated` does the strict check.
    expect(capture.last?.schema).toBeDefined();
    // Calling parse with a paginated wrapper-shape value should not throw.
    const stub = {
      total: 0,
      count: 0,
      page: 0,
      per_page: 25,
      data: { comments: [] },
    };
    const schema = capture.last!.schema;
    expect(() => {
      schema.parse(stub);
    }).not.toThrow();
  });
});
