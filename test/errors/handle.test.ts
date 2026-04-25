import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleTopLevelError } from '../../src/errors/handle.js';
import { FreeloApiError } from '../../src/errors/freelo-api-error.js';
import { ConfigError } from '../../src/errors/config-error.js';
import { ValidationError } from '../../src/errors/validation-error.js';
import { NetworkError } from '../../src/errors/network-error.js';
import { RateLimitedError } from '../../src/errors/rate-limited-error.js';

/**
 * Tests for handleTopLevelError:
 * - human mode: message + hintNext on stderr, no stack, exits with err.exitCode
 * - json mode: freelo.error/v1 envelope on stderr
 * - non-BaseError: becomes INTERNAL_ERROR exit 1
 * - AbortError-shaped error: exit 130
 * - secrets never leak
 */

describe('handleTopLevelError — human mode', () => {
  let stderrWrites: string[] = [];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let savedDebug: string | undefined;

  beforeEach(() => {
    stderrWrites = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
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

  it('prints the error message to stderr in human mode', () => {
    const err = new ValidationError('bad input');
    expect(() => handleTopLevelError(err, 'human')).toThrow();
    expect(stderrWrites.join('')).toContain('bad input');
  });

  it('prints hintNext to stderr in human mode when present', () => {
    const err = new ConfigError('missing token', { kind: 'missing-token', profile: 'default' });
    expect(() => handleTopLevelError(err, 'human')).toThrow();
    const output = stderrWrites.join('');
    expect(output).toContain('hint:');
    expect(output).toContain('freelo auth login');
  });

  it('exits with the error exitCode in human mode', () => {
    const err = new ValidationError('bad input'); // exitCode 2
    expect(() => handleTopLevelError(err, 'human')).toThrow('process.exit(2)');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('does not write to stdout in human mode', () => {
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    const err = new ValidationError('bad');
    expect(() => handleTopLevelError(err, 'human')).toThrow();
    expect(stdoutWrites).toHaveLength(0);
  });

  it('does not print stack by default in human mode', () => {
    const err = new ValidationError('bad input');
    expect(() => handleTopLevelError(err, 'human')).toThrow();
    const output = stderrWrites.join('');
    expect(output).not.toContain('at ');
  });

  it('prints stack when FREELO_DEBUG=1 in human mode', () => {
    process.env['FREELO_DEBUG'] = '1';
    const err = new ValidationError('bad input');
    expect(() => handleTopLevelError(err, 'human')).toThrow();
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
    vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code ?? ''})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a freelo.error/v1 envelope on stderr in json mode', () => {
    const err = new FreeloApiError('Invalid credentials.', 'AUTH_EXPIRED', { httpStatus: 401 });
    expect(() => handleTopLevelError(err, 'json')).toThrow();
    const combined = stderrWrites.join('');
    const parsed = JSON.parse(combined.trim()) as { schema: string; error: { code: string } };
    expect(parsed.schema).toBe('freelo.error/v1');
    expect(parsed.error.code).toBe('AUTH_EXPIRED');
  });

  it('includes http_status in the json error envelope', () => {
    const err = new FreeloApiError('Forbidden.', 'FORBIDDEN', { httpStatus: 403 });
    expect(() => handleTopLevelError(err, 'json')).toThrow();
    const parsed = JSON.parse(stderrWrites.join('').trim()) as {
      error: { http_status: number };
    };
    expect(parsed.error.http_status).toBe(403);
  });

  it('includes retryable in the json error envelope', () => {
    const err = new NetworkError('DNS failure'); // retryable: true
    expect(() => handleTopLevelError(err, 'json')).toThrow();
    const parsed = JSON.parse(stderrWrites.join('').trim()) as {
      error: { retryable: boolean };
    };
    expect(parsed.error.retryable).toBe(true);
  });

  it('includes hint_next when set', () => {
    const err = new ConfigError('missing token', { kind: 'missing-token', profile: 'default' });
    expect(() => handleTopLevelError(err, 'json')).toThrow();
    const parsed = JSON.parse(stderrWrites.join('').trim()) as {
      error: { hint_next: string };
    };
    expect(typeof parsed.error.hint_next).toBe('string');
    expect(parsed.error.hint_next.length).toBeGreaterThan(0);
  });

  it('does not write anything to stdout in json mode', () => {
    const err = new ValidationError('bad input');
    expect(() => handleTopLevelError(err, 'json')).toThrow();
    expect(stdoutWrites).toHaveLength(0);
  });

  it('exits with correct code for AUTH_EXPIRED (exit 3)', () => {
    const exitSpy = vi.spyOn(process, 'exit');
    const err = FreeloApiError.fromResponse({ status: 401 });
    expect(() => handleTopLevelError(err, 'json')).toThrow('process.exit(3)');
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it('exits with code 4 for FREELO_API_ERROR', () => {
    const exitSpy = vi.spyOn(process, 'exit');
    const err = FreeloApiError.fromResponse({ status: 500 });
    expect(() => handleTopLevelError(err, 'json')).toThrow('process.exit(4)');
    expect(exitSpy).toHaveBeenCalledWith(4);
  });

  it('exits with code 5 for NetworkError', () => {
    const exitSpy = vi.spyOn(process, 'exit');
    const err = new NetworkError('network fail');
    expect(() => handleTopLevelError(err, 'json')).toThrow('process.exit(5)');
    expect(exitSpy).toHaveBeenCalledWith(5);
  });

  it('exits with code 6 for RateLimitedError', () => {
    const exitSpy = vi.spyOn(process, 'exit');
    const err = new RateLimitedError('rate limited');
    expect(() => handleTopLevelError(err, 'json')).toThrow('process.exit(6)');
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
    vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code ?? ''})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps a plain Error to INTERNAL_ERROR exit 1 in json mode', () => {
    const exitSpy = vi.spyOn(process, 'exit');
    const err = new Error('unexpected boom');
    expect(() => handleTopLevelError(err, 'json')).toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);

    const parsed = JSON.parse(stderrWrites.join('').trim()) as {
      error: { code: string };
    };
    expect(parsed.error.code).toBe('INTERNAL_ERROR');
  });

  it('maps a thrown string to INTERNAL_ERROR in json mode', () => {
    expect(() => handleTopLevelError('string error', 'json')).toThrow('process.exit(1)');
    const parsed = JSON.parse(stderrWrites.join('').trim()) as {
      error: { code: string; message: string };
    };
    expect(parsed.error.code).toBe('INTERNAL_ERROR');
    expect(parsed.error.message).toBe('string error');
  });

  it('maps a plain Error to INTERNAL_ERROR exit 1 in human mode', () => {
    const exitSpy = vi.spyOn(process, 'exit');
    const err = new Error('unexpected boom');
    expect(() => handleTopLevelError(err, 'human')).toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('handleTopLevelError — AbortError routes to exit 130', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code ?? ''})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 130 when a raw AbortError is thrown', () => {
    const exitSpy = vi.spyOn(process, 'exit');
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(() => handleTopLevelError(abort, 'json')).toThrow('process.exit(130)');
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('exits 130 when a NetworkError wrapping an AbortError is thrown', () => {
    const exitSpy = vi.spyOn(process, 'exit');
    const cause = new Error('aborted');
    cause.name = 'AbortError';
    const err = new NetworkError('Request aborted.', { cause });
    expect(() => handleTopLevelError(err, 'json')).toThrow('process.exit(130)');
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
    vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code ?? ''})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a freelo.error/v1 envelope on stderr in ndjson mode', () => {
    const err = new ValidationError('bad flag');
    expect(() => handleTopLevelError(err, 'ndjson')).toThrow();
    const combined = stderrWrites.join('');
    const parsed = JSON.parse(combined.trim()) as { schema: string };
    expect(parsed.schema).toBe('freelo.error/v1');
  });
});
