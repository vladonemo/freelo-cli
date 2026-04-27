/**
 * Unit tests for `src/api/tasks-description.ts` (R15, spec 0026 §4.3).
 *
 * Pure-function checks for `setDescriptionPath` and `buildSetDescriptionBody`.
 * The `setTaskDescription` wire wrapper itself is exercised through the
 * MSW-backed integration tests in `test/commands/tasks/description-set.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { setDescriptionPath, buildSetDescriptionBody } from '../../src/api/tasks-description.js';

describe('setDescriptionPath', () => {
  it('builds /task/<id>/description', () => {
    expect(setDescriptionPath(42)).toBe('/task/42/description');
    expect(setDescriptionPath(9_999_999)).toBe('/task/9999999/description');
  });
});

describe('buildSetDescriptionBody', () => {
  it('returns { content } unchanged', () => {
    expect(buildSetDescriptionBody({ content: 'hello' })).toEqual({ content: 'hello' });
  });

  it('preserves multi-line content', () => {
    const body = buildSetDescriptionBody({ content: 'line 1\nline 2\n' });
    expect(body.content).toBe('line 1\nline 2\n');
  });

  it('preserves UTF-8 multibyte characters', () => {
    const body = buildSetDescriptionBody({ content: 'é — ✓ — 中文' });
    expect(body.content).toBe('é — ✓ — 中文');
  });

  it('returns an empty body for empty content (helper does not enforce non-empty)', () => {
    // The command layer rejects empty content (spec 0026 §5.7); the helper
    // is the wire-level builder and is intentionally lenient.
    expect(buildSetDescriptionBody({ content: '' })).toEqual({ content: '' });
  });
});
