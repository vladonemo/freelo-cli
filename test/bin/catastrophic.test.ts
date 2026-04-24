import { afterEach, describe, expect, it, vi } from 'vitest';
import { isEntryPoint, run, writeCatastrophicError } from '../../src/bin/freelo.js';

/**
 * Covers the catastrophic-path helpers and the `run()` entry in
 * `src/bin/freelo.ts`. The `if (isEntryPoint())` bootstrap on the
 * outermost module scope is exercised by the smoke test in CI.
 */
describe('writeCatastrophicError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a plain "freelo: <msg>" line on stderr when stdout is a TTY', () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    try {
      writeCatastrophicError('boom');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: originalIsTTY,
      });
    }

    expect(writes).toEqual(['freelo: boom\n']);
  });

  it('emits a freelo.error/v1 envelope on stderr when stdout is not a TTY', () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });

    try {
      writeCatastrophicError('boom');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: originalIsTTY,
      });
    }

    expect(writes).toHaveLength(1);
    const payload = JSON.parse(writes[0]!.trimEnd()) as {
      schema: string;
      error: { code: string; message: string; retryable: boolean };
    };
    expect(payload).toEqual({
      schema: 'freelo.error/v1',
      error: { code: 'INTERNAL_ERROR', message: 'boom', retryable: false },
    });
  });
});

describe('isEntryPoint', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when process.argv[1] is empty', () => {
    const original = process.argv[1] ?? '';
    process.argv[1] = '';
    try {
      expect(isEntryPoint()).toBe(false);
    } finally {
      process.argv[1] = original;
    }
  });

  it('returns false when process.argv[1] cannot be realpath-resolved', () => {
    const original = process.argv[1] ?? '';
    // Path that definitely does not exist on disk — exercises the catch branch.
    process.argv[1] = '/this/path/does/not/exist/freelo-bin-xyz';
    try {
      expect(isEntryPoint()).toBe(false);
    } finally {
      process.argv[1] = original;
    }
  });

  it('returns false when imported by tests (argv[1] is the vitest runner)', () => {
    // Under vitest, argv[1] resolves to the vitest binary, not this module.
    expect(isEntryPoint()).toBe(false);
  });
});

describe('run', () => {
  it('parses argv without throwing when no subcommand is given', async () => {
    // No subcommands registered yet → parsing `[node, freelo]` is a no-op.
    await expect(run(['node', 'freelo'])).resolves.toBeUndefined();
  });
});
