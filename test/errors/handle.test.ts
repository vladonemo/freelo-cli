import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleTopLevelError } from '../../src/errors/handle.js';
import { FreeloApiError } from '../../src/errors/freelo-api-error.js';
import { ConfigError } from '../../src/errors/config-error.js';
import { ValidationError } from '../../src/errors/validation-error.js';
import { NetworkError } from '../../src/errors/network-error.js';
import { RateLimitedError } from '../../src/errors/rate-limited-error.js';
import { getGlobalDispatcher } from 'undici';

// Mock the undici namespace so we can swap getGlobalDispatcher() per-test.
// `getGlobalDispatcher` returns the live keep-alive Pool/Agent in production;
// in tests we need to assert the handler calls .close() on it before exit.
vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    getGlobalDispatcher: vi.fn(actual.getGlobalDispatcher),
  };
});

/**
 * Tests for handleTopLevelError:
 * - human mode: message + hintNext on stderr, no stack, exits with err.exitCode
 * - json mode: freelo.error/v1 envelope on stderr
 * - non-BaseError: becomes INTERNAL_ERROR exit 1
 * - AbortError-shaped error: exit 130
 * - secrets never leak
 * - undici dispatcher is drained before process.exit (Windows libuv)
 */

describe('handleTopLevelError — human mode', () => {
  let stderrWrites: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: ReturnType<typeof vi.spyOn<any, any>>;
  let savedDebug: string | undefined;

  beforeEach(() => {
    stderrWrites = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code ?? ''})`);
    });
    savedDebug = process.env['FREELO_DEBUG'];
    delete process.env['FREELO_DEBUG'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedDebug !== undefined) {
      process.env['FREELO_DEBUG'] = savedDebug;
    } else {
      delete process.env['FREELO_DEBUG'];
    }
  });

  it('prints the error message to stderr in human mode', async () => {
    const err = new ValidationError('bad input');
    await expect(handleTopLevelError(err, 'human')).rejects.toThrow();
    expect(stderrWrites.join('')).toContain('bad input');
  });

  it('prints hintNext to stderr in human mode when present', async () => {
    const err = new ConfigError('missing token', { kind: 'missing-token', profile: 'default' });
    await expect(handleTopLevelError(err, 'human')).rejects.toThrow();
    const output = stderrWrites.join('');
    expect(output).toContain('hint:');
    expect(output).toContain('freelo auth login');
  });

  it('exits with the error exitCode in human mode', async () => {
    const err = new ValidationError('bad input'); // exitCode 2
    await expect(handleTopLevelError(err, 'human')).rejects.toThrow('process.exit(2)');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('does not write to stdout in human mode', async () => {
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    const err = new ValidationError('bad');
    await expect(handleTopLevelError(err, 'human')).rejects.toThrow();
    expect(stdoutWrites).toHaveLength(0);
  });

  it('does not print stack by default in human mode', async () => {
    const err = new ValidationError('bad input');
    await expect(handleTopLevelError(err, 'human')).rejects.toThrow();
    const output = stderrWrites.join('');
    expect(output).not.toContain('at ');
  });

  it('prints stack when FREELO_DEBUG=1 in human mode', async () => {
    process.env['FREELO_DEBUG'] = '1';
    const err = new ValidationError('bad input');
    await expect(handleTopLevelError(err, 'human')).rejects.toThrow();
    const output = stderrWrites.join('');
    // Stack should be present
    expect(output).toContain('ValidationError');
  });
});

describe('handleTopLevelError — json mode', () => {
  let stderrWrites: string[] = [];
  let stdoutWrites: string[] = [];

  beforeEach(() => {
    stderrWrites = [];
    stdoutWrites = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code ?? ''})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a freelo.error/v1 envelope on stderr in json mode', async () => {
    const err = new FreeloApiError('Invalid credentials.', 'AUTH_EXPIRED', { httpStatus: 401 });
    await expect(handleTopLevelError(err, 'json')).rejects.toThrow();
    const combined = stderrWrites.join('');
    const parsed = JSON.parse(combined.trim()) as { schema: string; error: { code: string } };
    expect(parsed.schema).toBe('freelo.error/v1');
    expect(parsed.error.code).toBe('AUTH_EXPIRED');
  });

  it('includes http_status in the json error envelope', async () => {
    const err = new FreeloApiError('Forbidden.', 'FORBIDDEN', { httpStatus: 403 });
    await expect(handleTopLevelError(err, 'json')).rejects.toThrow();
    const parsed = JSON.parse(stderrWrites.join('').trim()) as {
      error: { http_status: number };
    };
    expect(parsed.error.http_status).toBe(403);
  });

  it('includes retryable in the json error envelope', async () => {
    const err = new NetworkError('DNS failure'); // retryable: true
    await expect(handleTopLevelError(err, 'json')).rejects.toThrow();
    const parsed = JSON.parse(stderrWrites.join('').trim()) as {
      error: { retryable: boolean };
    };
    expect(parsed.error.retryable).toBe(true);
  });

  it('includes hint_next when set', async () => {
    const err = new ConfigError('missing token', { kind: 'missing-token', profile: 'default' });
    await expect(handleTopLevelError(err, 'json')).rejects.toThrow();
    const parsed = JSON.parse(stderrWrites.join('').trim()) as {
      error: { hint_next: string };
    };
    expect(typeof parsed.error.hint_next).toBe('string');
    expect(parsed.error.hint_next.length).toBeGreaterThan(0);
  });

  it('does not write anything to stdout in json mode', async () => {
    const err = new ValidationError('bad input');
    await expect(handleTopLevelError(err, 'json')).rejects.toThrow();
    expect(stdoutWrites).toHaveLength(0);
  });

  it('exits with correct code for AUTH_EXPIRED (exit 3)', async () => {
    const exitSpy = vi.spyOn(process, 'exit');
    const err = FreeloApiError.fromResponse({ status: 401 });
    await expect(handleTopLevelError(err, 'json')).rejects.toThrow('process.exit(3)');
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it('exits with code 4 for FREELO_API_ERROR', async () => {
    const exitSpy = vi.spyOn(process, 'exit');
    const err = FreeloApiError.fromResponse({ status: 500 });
    await expect(handleTopLevelError(err, 'json')).rejects.toThrow('process.exit(4)');
    expect(exitSpy).toHaveBeenCalledWith(4);
  });

  it('exits with code 5 for NetworkError', async () => {
    const exitSpy = vi.spyOn(process, 'exit');
    const err = new NetworkError('network fail');
    await expect(handleTopLevelError(err, 'json')).rejects.toThrow('process.exit(5)');
    expect(exitSpy).toHaveBeenCalledWith(5);
  });

  it('exits with code 6 for RateLimitedError', async () => {
    const exitSpy = vi.spyOn(process, 'exit');
    const err = new RateLimitedError('rate limited');
    await expect(handleTopLevelError(err, 'json')).rejects.toThrow('process.exit(6)');
    expect(exitSpy).toHaveBeenCalledWith(6);
  });
});

describe('handleTopLevelError — non-BaseError becomes INTERNAL_ERROR', () => {
  let stderrWrites: string[] = [];

  beforeEach(() => {
    stderrWrites = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code ?? ''})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps a plain Error to INTERNAL_ERROR exit 1 in json mode', async () => {
    const exitSpy = vi.spyOn(process, 'exit');
    const err = new Error('unexpected boom');
    await expect(handleTopLevelError(err, 'json')).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);

    const parsed = JSON.parse(stderrWrites.join('').trim()) as {
      error: { code: string };
    };
    expect(parsed.error.code).toBe('INTERNAL_ERROR');
  });

  it('maps a thrown string to INTERNAL_ERROR in json mode', async () => {
    await expect(handleTopLevelError('string error', 'json')).rejects.toThrow('process.exit(1)');
    const parsed = JSON.parse(stderrWrites.join('').trim()) as {
      error: { code: string; message: string };
    };
    expect(parsed.error.code).toBe('INTERNAL_ERROR');
    expect(parsed.error.message).toBe('string error');
  });

  it('maps a plain Error to INTERNAL_ERROR exit 1 in human mode', async () => {
    const exitSpy = vi.spyOn(process, 'exit');
    const err = new Error('unexpected boom');
    await expect(handleTopLevelError(err, 'human')).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('handleTopLevelError — AbortError routes to exit 130', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code ?? ''})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 130 when a raw AbortError is thrown', async () => {
    const exitSpy = vi.spyOn(process, 'exit');
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    await expect(handleTopLevelError(abort, 'json')).rejects.toThrow('process.exit(130)');
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('exits 130 when a NetworkError wrapping an AbortError is thrown', async () => {
    const exitSpy = vi.spyOn(process, 'exit');
    const cause = new Error('aborted');
    cause.name = 'AbortError';
    const err = new NetworkError('Request aborted.', { cause });
    await expect(handleTopLevelError(err, 'json')).rejects.toThrow('process.exit(130)');
    expect(exitSpy).toHaveBeenCalledWith(130);
  });
});

describe('handleTopLevelError — ndjson mode behaves like json', () => {
  let stderrWrites: string[] = [];

  beforeEach(() => {
    stderrWrites = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code ?? ''})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a freelo.error/v1 envelope on stderr in ndjson mode', async () => {
    const err = new ValidationError('bad flag');
    await expect(handleTopLevelError(err, 'ndjson')).rejects.toThrow();
    const combined = stderrWrites.join('');
    const parsed = JSON.parse(combined.trim()) as { schema: string };
    expect(parsed.schema).toBe('freelo.error/v1');
  });
});

describe('handleTopLevelError — drains undici dispatcher before exit (libuv fix)', () => {
  /**
   * Regression for the Windows libuv crash:
   *
   *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
   *     file src\\win\\async.c, line 76
   *
   * Round-2 fix (spec 0015 §3, R05.5): the prior `.close()` (graceful) was
   * incomplete on Windows. We now call `getGlobalDispatcher().destroy()`
   * (forceful) bounded by a 250 ms timeout race, then defer
   * `process.exit` via `setImmediate` so libuv has one event-loop tick to
   * finalize close callbacks before the synchronous exit.
   *
   * The full Windows-only crash can't be reproduced inside the test
   * runner. The unit test below verifies the call ordering as a proxy;
   * the real condition (no `UV_HANDLE_CLOSING` in stderr on Windows) is
   * asserted by `test/integration/windows-libuv-exit.test.ts`.
   */
  let destroySpy: ReturnType<typeof vi.fn>;
  let exitOrder: string[];

  beforeEach(() => {
    exitOrder = [];

    destroySpy = vi.fn(() => {
      exitOrder.push('dispatcher.destroy');
      return Promise.resolve();
    });

    vi.mocked(getGlobalDispatcher).mockReturnValue({
      destroy: destroySpy,
      // The handler only calls .destroy(); nothing else needs to be present.
    } as unknown as ReturnType<typeof getGlobalDispatcher>);

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      exitOrder.push(`process.exit(${_code ?? ''})`);
      throw new Error(`process.exit(${_code ?? ''})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls getGlobalDispatcher().destroy() before process.exit on a typed error', async () => {
    const err = new ValidationError('bad input');
    await expect(handleTopLevelError(err, 'json')).rejects.toThrow('process.exit(2)');
    expect(destroySpy).toHaveBeenCalledOnce();
    expect(exitOrder).toEqual(['dispatcher.destroy', 'process.exit(2)']);
  });

  it('drains the dispatcher before exit on the SIGINT/AbortError path', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    await expect(handleTopLevelError(abort, 'json')).rejects.toThrow('process.exit(130)');
    expect(destroySpy).toHaveBeenCalledOnce();
    expect(exitOrder).toEqual(['dispatcher.destroy', 'process.exit(130)']);
  });

  it('still exits cleanly when dispatcher.destroy() rejects', async () => {
    destroySpy.mockImplementationOnce(() => {
      exitOrder.push('dispatcher.destroy.rejected');
      return Promise.reject(new Error('destroy failed'));
    });
    const err = new ValidationError('bad input');
    // The original exit code must survive the destroy() rejection.
    await expect(handleTopLevelError(err, 'json')).rejects.toThrow('process.exit(2)');
    expect(exitOrder).toEqual(['dispatcher.destroy.rejected', 'process.exit(2)']);
  });

  it('exits even when dispatcher.destroy() hangs past the timeout (250 ms race)', async () => {
    // Simulate a hung destroy() — never resolves. The timeout race must
    // fire so the CLI does not hang on exit.
    destroySpy.mockImplementationOnce(() => {
      exitOrder.push('dispatcher.destroy.started');
      return new Promise<void>(() => {}); // never resolves
    });
    const err = new ValidationError('bad input');
    // Race resolves via the 250 ms setTimeout. We use real timers so the
    // race actually fires; the test takes ~250 ms but is deterministic.
    await expect(handleTopLevelError(err, 'json')).rejects.toThrow('process.exit(2)');
    expect(exitOrder).toContain('dispatcher.destroy.started');
    expect(exitOrder).toContain('process.exit(2)');
  });
});
