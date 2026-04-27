import { describe, expect, it } from 'vitest';
import { buildQuery } from '../../src/lib/query.js';

/**
 * Unit tests for `buildQuery` (src/lib/query.ts).
 *
 * Spec 0017 §2.5 — encoding policy. The exact wire format is load-bearing
 * because Freelo's API matches `projects_ids[]=42` (percent-encoded as
 * `projects_ids%5B%5D=42`) literally; misencoding would silently route
 * filters into the void.
 */

describe('buildQuery', () => {
  it('returns empty string for empty input', () => {
    expect(buildQuery({})).toBe('');
  });

  it('emits scalar string and number values', () => {
    expect(buildQuery({ search_query: 'redesign', p: 0 })).toBe('search_query=redesign&p=0');
  });

  it('emits boolean true as the literal string "true"', () => {
    expect(buildQuery({ no_due_date: true })).toBe('no_due_date=true');
  });

  it('omits boolean false values entirely', () => {
    expect(buildQuery({ no_due_date: false, finished_overdue: true })).toBe(
      'finished_overdue=true',
    );
  });

  it('omits undefined values', () => {
    expect(buildQuery({ p: 0, search_query: undefined, order: 'asc' })).toBe('p=0&order=asc');
  });

  it('emits arrays as repeating key=value pairs with percent-encoded brackets', () => {
    // The `[]` in the key gets encoded once by URLSearchParams.append. The
    // *order* of values is preserved (Freelo sees them in the order the user
    // passed them, which agents may rely on for `--label` precedence).
    expect(buildQuery({ 'projects_ids[]': [42, 43] })).toBe(
      'projects_ids%5B%5D=42&projects_ids%5B%5D=43',
    );
  });

  it('handles string arrays for label-style filters', () => {
    expect(buildQuery({ 'with_labels[]': ['bug', 'p1'] })).toBe(
      'with_labels%5B%5D=bug&with_labels%5B%5D=p1',
    );
  });

  it('omits empty arrays entirely (no orphan key[] placeholder)', () => {
    expect(buildQuery({ 'projects_ids[]': [], p: 0 })).toBe('p=0');
  });

  it('emits bracketed-object keys for date-range params', () => {
    expect(
      buildQuery({
        'due_date_range[date_from]': '2026-04-01',
        'due_date_range[date_to]': '2026-04-30',
      }),
    ).toBe('due_date_range%5Bdate_from%5D=2026-04-01&due_date_range%5Bdate_to%5D=2026-04-30');
  });

  it('handles a realistic mix of all encoding shapes', () => {
    const q = buildQuery({
      'projects_ids[]': [42, 43],
      'tasklists_ids[]': [101],
      'with_labels[]': ['bug', 'p1'],
      without_label: 'wontfix',
      'due_date_range[date_from]': '2026-04-01',
      no_due_date: false, // omitted
      finished_overdue: true,
      worker_id: 7,
      search_query: undefined, // omitted
      p: 0,
    });

    expect(q).toBe(
      [
        'projects_ids%5B%5D=42',
        'projects_ids%5B%5D=43',
        'tasklists_ids%5B%5D=101',
        'with_labels%5B%5D=bug',
        'with_labels%5B%5D=p1',
        'without_label=wontfix',
        'due_date_range%5Bdate_from%5D=2026-04-01',
        'finished_overdue=true',
        'worker_id=7',
        'p=0',
      ].join('&'),
    );
  });

  it('percent-encodes special characters in values', () => {
    // Spaces, ampersands, equals — anything that would corrupt the query
    // string if emitted raw.
    expect(buildQuery({ search_query: 'Site Redesign & Launch' })).toBe(
      'search_query=Site+Redesign+%26+Launch',
    );
  });
});
