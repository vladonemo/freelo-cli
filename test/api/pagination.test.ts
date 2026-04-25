import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  pagingFromNormalized,
  synthesizeUnpaginated,
  normalizePaginated,
  fetchAllPages,
  PartialPagesError,
  projectFields,
  type NormalizedPage,
} from '../../src/api/pagination.js';
import { ValidationError } from '../../src/errors/validation-error.js';
import { FreeloApiError } from '../../src/errors/freelo-api-error.js';

const Item = z.object({ id: z.number().int(), name: z.string() });

describe('pagingFromNormalized', () => {
  it('maps fields to the envelope Paging shape (snake_case)', () => {
    const np: NormalizedPage<{ id: number }> = {
      data: [],
      page: 2,
      perPage: 25,
      total: 137,
      nextCursor: 3,
    };
    expect(pagingFromNormalized(np)).toEqual({
      page: 2,
      per_page: 25,
      total: 137,
      next_cursor: 3,
    });
  });
});

describe('synthesizeUnpaginated', () => {
  it('synthesizes a single-page page with nextCursor null', () => {
    const out = synthesizeUnpaginated([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(out).toEqual({
      data: [{ id: 1 }, { id: 2 }, { id: 3 }],
      page: 0,
      perPage: 3,
      total: 3,
      nextCursor: null,
    });
  });

  it('handles an empty array (perPage = 0, total = 0)', () => {
    const out = synthesizeUnpaginated([]);
    expect(out).toEqual({ data: [], page: 0, perPage: 0, total: 0, nextCursor: null });
  });
});

describe('normalizePaginated', () => {
  it('extracts the inner array, page, total and computes nextCursor', () => {
    const raw = {
      total: 75,
      count: 25,
      page: 0,
      per_page: 25,
      data: { projects: [{ id: 1, name: 'A' }] },
    };
    const out = normalizePaginated(raw, 'projects', Item);
    expect(out.page).toBe(0);
    expect(out.total).toBe(75);
    expect(out.perPage).toBe(25);
    expect(out.nextCursor).toBe(1);
    expect(out.data).toEqual([{ id: 1, name: 'A' }]);
  });

  it('returns nextCursor: null on the last page', () => {
    const raw = {
      total: 50,
      count: 25,
      page: 1,
      per_page: 25,
      data: { projects: [] },
    };
    const out = normalizePaginated(raw, 'projects', Item);
    expect(out.nextCursor).toBeNull();
  });

  it('throws FreeloApiError when the wrapper is malformed', () => {
    expect(() => normalizePaginated({ not_a_wrapper: true }, 'projects', Item)).toThrow(
      FreeloApiError,
    );
  });
});

describe('fetchAllPages', () => {
  it('iterates pages until nextCursor is null and merges data', async () => {
    const pages: NormalizedPage<{ id: number; name: string }>[] = [
      { data: [{ id: 1, name: 'a' }], page: 0, perPage: 1, total: 3, nextCursor: 1 },
      { data: [{ id: 2, name: 'b' }], page: 1, perPage: 1, total: 3, nextCursor: 2 },
      { data: [{ id: 3, name: 'c' }], page: 2, perPage: 1, total: 3, nextCursor: null },
    ];
    const fetchPage = vi.fn((p: number) => Promise.resolve(pages[p]!));
    const onPage = vi.fn();
    const out = await fetchAllPages({ fetchPage, onPage });
    expect(out.data).toHaveLength(3);
    expect(out.page).toBe(2);
    expect(out.nextCursor).toBeNull();
    expect(onPage).toHaveBeenCalledTimes(3);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('throws PartialPagesError on mid-stream failure with accumulated data', async () => {
    const fetchPage = vi.fn((p: number): Promise<NormalizedPage<{ id: number }>> => {
      if (p === 1) return Promise.reject(new Error('boom'));
      return Promise.resolve({
        data: [{ id: 1 }],
        page: 0,
        perPage: 1,
        total: 5,
        nextCursor: 1,
      });
    });
    let caught: unknown;
    try {
      await fetchAllPages({ fetchPage });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PartialPagesError);
    const err = caught as PartialPagesError<{ id: number }>;
    expect(err.failedPage).toBe(1);
    expect(err.accumulated.data).toEqual([{ id: 1 }]);
    expect(err.accumulated.nextCursor).toBe(1);
  });

  it('rethrows the underlying error if the very first page fails', async () => {
    const fetchPage = vi.fn(() => Promise.reject(new Error('first-fail')));
    await expect(fetchAllPages({ fetchPage })).rejects.toThrow('first-fail');
  });

  it('honours an aborted signal mid-iteration', async () => {
    const controller = new AbortController();
    const fetchPage = vi.fn((p: number): Promise<NormalizedPage<{ id: number }>> => {
      if (p === 1) controller.abort();
      return Promise.resolve({
        data: [{ id: p }],
        page: p,
        perPage: 1,
        total: 5,
        nextCursor: p + 1,
      });
    });
    let caught: unknown;
    try {
      await fetchAllPages({ fetchPage, signal: controller.signal });
    } catch (e) {
      caught = e;
    }
    // Either AbortError (no pages yet) or PartialPagesError (we got page 0 first)
    expect(caught).toBeDefined();
    if (caught instanceof PartialPagesError) {
      expect(caught.accumulated.data.length).toBeGreaterThanOrEqual(1);
    } else {
      expect((caught as Error).name).toBe('AbortError');
    }
  });

  it('returns immediately when a single page reports nextCursor: null', async () => {
    const fetchPage = vi.fn(
      (): Promise<NormalizedPage<{ id: number }>> =>
        Promise.resolve({
          data: [{ id: 1 }, { id: 2 }],
          page: 0,
          perPage: 25,
          total: 2,
          nextCursor: null,
        }),
    );
    const out = await fetchAllPages({ fetchPage });
    expect(out.data).toHaveLength(2);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});

describe('projectFields', () => {
  const known = ['id', 'name', 'date_add'] as const;
  const records = [
    { id: 1, name: 'A', date_add: '2026-01-01' },
    { id: 2, name: 'B' }, // missing date_add deliberately
  ];

  it('projects to the requested top-level fields', () => {
    const out = projectFields(records, ['id', 'name'], known, 'owned');
    expect(out).toEqual([
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
    ]);
  });

  it('omits absent fields rather than emitting null', () => {
    const out = projectFields(records, ['id', 'date_add'], known, 'owned');
    expect(out[0]).toEqual({ id: 1, date_add: '2026-01-01' });
    expect(out[1]).toEqual({ id: 2 }); // date_add absent, not null
  });

  it('throws ValidationError on empty fields', () => {
    expect(() => projectFields(records, [], known, 'owned')).toThrow(ValidationError);
  });

  it('throws ValidationError on unknown field with the valid set in the message', () => {
    try {
      projectFields(records, ['date_start'], known, 'owned');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const err = e as ValidationError;
      expect(err.message).toContain('date_start');
      expect(err.message).toContain('id, name, date_add');
    }
  });

  it('throws ValidationError on a nested field name', () => {
    try {
      projectFields(records, ['state.id'], [...known, 'state'], 'all');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).message).toContain('Nested');
    }
  });
});
