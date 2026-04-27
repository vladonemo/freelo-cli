/**
 * Unit tests for `src/lib/batch.ts` (R09 spec 0019 §3.5).
 *
 * Three exports:
 *   - `iterateLines` — async generator over a readable stream
 *   - `parseNdjsonLine` — tagged-union parse-and-validate
 *   - `ExitCodeAccumulator` — 1 > 2 > 0 priority merge
 *
 * Calibration §2: every typed-error path has a test. The `ValidationError`
 * branches in `parseNdjsonLine` are covered; the BaseError code/exit shape is
 * asserted directly.
 *
 * Calibration §4: each new try/catch arm in `parseNdjsonLine` (JSON.parse
 * catch, schema-fail branch) has its own test row.
 */

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ExitCodeAccumulator, iterateLines, parseNdjsonLine } from '../../src/lib/batch.js';
import { ValidationError } from '../../src/errors/validation-error.js';

function streamFrom(text: string): NodeJS.ReadableStream {
  return Readable.from([text]);
}

async function collect(stream: NodeJS.ReadableStream): Promise<string[]> {
  const out: string[] = [];
  for await (const line of iterateLines(stream)) out.push(line);
  return out;
}

describe('iterateLines', () => {
  it('yields each non-empty line from \\n-separated input', async () => {
    const lines = await collect(streamFrom('a\nb\nc\n'));
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('yields the trailing line when there is no final newline', async () => {
    const lines = await collect(streamFrom('a\nb\nc'));
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('handles CRLF line endings', async () => {
    const lines = await collect(streamFrom('a\r\nb\r\n'));
    expect(lines).toEqual(['a', 'b']);
  });

  it('skips empty and whitespace-only lines', async () => {
    const lines = await collect(streamFrom('a\n\n  \nb\n'));
    expect(lines).toEqual(['a', 'b']);
  });

  it('yields nothing for an empty stream', async () => {
    const lines = await collect(streamFrom(''));
    expect(lines).toEqual([]);
  });

  it('handles input split across chunks', async () => {
    const stream = Readable.from(['first li', 'ne\nsecond ', 'line\nthird\n']);
    const lines = await collect(stream);
    expect(lines).toEqual(['first line', 'second line', 'third']);
  });
});

describe('parseNdjsonLine', () => {
  const schema = z.object({ name: z.string().min(1) }).strict();

  it('returns ok on a valid line', () => {
    const result = parseNdjsonLine('{"name":"foo"}', 0, schema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ name: 'foo' });
      expect(result.lineIndex).toBe(0);
    }
  });

  it('returns ok=false with ValidationError on bad JSON (catch arm)', () => {
    const result = parseNdjsonLine('{"name":', 2, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.exitCode).toBe(2);
      expect(result.error.message).toMatch(/Line 3 is not valid JSON/);
      expect(result.lineIndex).toBe(2);
    }
  });

  it('returns ok=false on schema mismatch (unknown key via .strict())', () => {
    const result = parseNdjsonLine('{"name":"x","extra":1}', 0, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.exitCode).toBe(2);
      expect(result.error.message).toMatch(/Line 1/);
    }
  });

  it('returns ok=false on schema mismatch (wrong-type field)', () => {
    const result = parseNdjsonLine('{"name":42}', 5, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Line 6/);
      expect(result.error.message).toMatch(/name/);
    }
  });

  it('returns ok=false on schema mismatch (root-level non-object)', () => {
    const result = parseNdjsonLine('"just a string"', 0, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Line 1/);
    }
  });
});

describe('ExitCodeAccumulator', () => {
  it('starts at 0', () => {
    const acc = new ExitCodeAccumulator();
    expect(acc.value).toBe(0);
  });

  it('observing 0 keeps it at 0', () => {
    const acc = new ExitCodeAccumulator();
    acc.observe(0);
    expect(acc.value).toBe(0);
  });

  it('observing 2 raises 0 → 2', () => {
    const acc = new ExitCodeAccumulator();
    acc.observe(2);
    expect(acc.value).toBe(2);
  });

  it('observing 4 raises 0 → 4', () => {
    const acc = new ExitCodeAccumulator();
    acc.observe(4);
    expect(acc.value).toBe(4);
  });

  it('observing 4 after 2 raises 2 → 4 (HTTP > validation)', () => {
    const acc = new ExitCodeAccumulator();
    acc.observe(2);
    acc.observe(4);
    expect(acc.value).toBe(4);
  });

  it('observing 2 after 4 keeps it at 4 (highest wins)', () => {
    const acc = new ExitCodeAccumulator();
    acc.observe(4);
    acc.observe(2);
    expect(acc.value).toBe(4);
  });

  it('observing 6 (rate-limited) after 4 raises to 6', () => {
    const acc = new ExitCodeAccumulator();
    acc.observe(4);
    acc.observe(6);
    expect(acc.value).toBe(6);
  });

  it('observing 2 after 2 keeps it at 2', () => {
    const acc = new ExitCodeAccumulator();
    acc.observe(2);
    acc.observe(2);
    expect(acc.value).toBe(2);
  });
});
