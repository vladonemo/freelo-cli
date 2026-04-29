import { describe, expect, it } from 'vitest';
import { humanizeBytes } from '../../src/lib/format.js';

describe('humanizeBytes', () => {
  it('renders bytes < 1024 with " B" suffix', () => {
    expect(humanizeBytes(0)).toBe('0 B');
    expect(humanizeBytes(1)).toBe('1 B');
    expect(humanizeBytes(512)).toBe('512 B');
    expect(humanizeBytes(1023)).toBe('1023 B');
  });

  it('renders KB at the 1024 boundary', () => {
    expect(humanizeBytes(1024)).toBe('1.0 KB');
    expect(humanizeBytes(2048)).toBe('2.0 KB');
    expect(humanizeBytes(1024 * 1024 - 1)).toMatch(/KB$/);
  });

  it('renders MB at the 1024^2 boundary', () => {
    expect(humanizeBytes(1024 * 1024)).toBe('1.0 MB');
    expect(humanizeBytes(2_500_000)).toMatch(/2\.[34] MB/);
  });

  it('renders GB at and above the 1024^3 boundary', () => {
    expect(humanizeBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(humanizeBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });

  it('clamps NaN / negative / non-finite inputs to "0 B"', () => {
    expect(humanizeBytes(Number.NaN)).toBe('0 B');
    expect(humanizeBytes(-1)).toBe('0 B');
    expect(humanizeBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});
