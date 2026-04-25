import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, usersMeHandlers } from '../../msw/handlers.js';

vi.mock('keytar', () => ({
  default: { getPassword: vi.fn(), setPassword: vi.fn(), deletePassword: vi.fn() },
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
}));

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let firstExitCode: number | undefined;

  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  // Capture the FIRST exit code only. The run() outer catch may re-call
  // process.exit with code 1 after catching the thrown mock error.
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
    if (firstExitCode === undefined) firstExitCode = _code ?? 0;
    throw new Error(`EXIT:${_code ?? 0}`);
  });

  return {
    stdout,
    stderr,
    getFirstExitCode: () => firstExitCode,
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    },
  };
}

async function runLogin(
  runFn: (argv: string[]) => Promise<void>,
  extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { stdout, stderr, getFirstExitCode, restore } = captureOutput();

  try {
    await runFn(['node', 'freelo', 'auth', 'login', '--output', 'json', ...extraArgs]);
  } catch {
    // Swallow — exit code captured by mock.
  } finally {
    restore();
  }

  return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: getFirstExitCode() ?? 0 };
}

/** Parse the first valid JSON line from a string that starts with '{'. */
function parseFirstJson(text: string): unknown {
  const lines = text.split('\n').filter((l) => l.trim().startsWith('{'));
  for (const line of lines) {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      // try next
    }
  }
  throw new Error(`No valid JSON line found in: ${JSON.stringify(text)}`);
}

describe('auth login — env-mode happy path', () => {
  let testDir: string;
  let storeData: Record<string, unknown>;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-login-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });

    storeData = {};
    vi.doMock('conf', () => {
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: (key: string) => key in storeData,
        get store() {
          return { ...storeData };
        },
        set store(val: Record<string, unknown>) {
          for (const k of Object.keys(storeData)) delete storeData[k];
          Object.assign(storeData, val);
        },
      }));
      return { default: ConfMock };
    });

    vi.resetModules();

    process.env['FREELO_API_KEY'] = 'sk-test';
    process.env['FREELO_EMAIL'] = 'agent@example.cz';
    process.env['FREELO_NO_KEYCHAIN'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });

    server.use(usersMeHandlers.ok());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    delete process.env['FREELO_NO_KEYCHAIN'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('emits a freelo.auth.login/v1 envelope on stdout', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runLogin(run);
    const parsed = parseFirstJson(stdout) as { schema: string };
    expect(parsed.schema).toBe('freelo.auth.login/v1');
    expect(exitCode).toBe(0);
  });

  it('includes profile, email, user_id in the data', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runLogin(run);
    const parsed = parseFirstJson(stdout) as {
      data: { profile: string; email: string; user_id: number; replaced: boolean };
    };
    expect(parsed.data.profile).toBe('default');
    expect(parsed.data.email).toBe('agent@example.cz');
    expect(parsed.data.user_id).toBe(12345);
  });

  it('has replaced: false for a fresh profile', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runLogin(run);
    const parsed = parseFirstJson(stdout) as { data: { replaced: boolean } };
    expect(parsed.data.replaced).toBe(false);
  });

  it('sets replaced: true when the profile already exists', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    // First login creates the profile
    await runLogin(run);
    // Second login should replace it — re-import run since modules were reset
    vi.resetModules();
    vi.doMock('conf', () => {
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: (key: string) => key in storeData,
        get store() {
          return { ...storeData };
        },
        set store(val: Record<string, unknown>) {
          for (const k of Object.keys(storeData)) delete storeData[k];
          Object.assign(storeData, val);
        },
      }));
      return { default: ConfMock };
    });

    const { run: run2 } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runLogin(run2);
    const parsed = parseFirstJson(stdout) as { data: { replaced: boolean } };
    expect(parsed.data.replaced).toBe(true);
  });

  it('includes a notice field when replacing an existing profile', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    await runLogin(run);

    vi.resetModules();
    vi.doMock('conf', () => {
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: (key: string) => key in storeData,
        get store() {
          return { ...storeData };
        },
        set store(val: Record<string, unknown>) {
          for (const k of Object.keys(storeData)) delete storeData[k];
          Object.assign(storeData, val);
        },
      }));
      return { default: ConfMock };
    });

    const { run: run2 } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runLogin(run2);
    const parsed = parseFirstJson(stdout) as { notice?: string };
    expect(typeof parsed.notice).toBe('string');
    expect(parsed.notice).toContain('Replaced');
  });
});

describe('auth login — 401 response', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-login-401-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    vi.doMock('conf', () => {
      const data: Record<string, unknown> = {};
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: (key: string) => key in data,
        get store() {
          return { ...data };
        },
        set store(val: Record<string, unknown>) {
          for (const k of Object.keys(data)) delete data[k];
          Object.assign(data, val);
        },
      }));
      return { default: ConfMock };
    });

    vi.resetModules();

    process.env['FREELO_API_KEY'] = 'sk-expired';
    process.env['FREELO_EMAIL'] = 'user@example.com';
    process.env['FREELO_NO_KEYCHAIN'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });

    server.use(usersMeHandlers.unauthorized());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    delete process.env['FREELO_NO_KEYCHAIN'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('exits with code 3 on 401', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runLogin(run);
    expect(exitCode).toBe(3);
  });

  it('does not write a success envelope to stdout on 401', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runLogin(run);
    expect(stdout.trim()).toBe('');
  });

  it('emits freelo.error/v1 with AUTH_EXPIRED on 401', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr } = await runLogin(run);
    const parsed = parseFirstJson(stderr) as { schema: string; error: { code: string } };
    expect(parsed.schema).toBe('freelo.error/v1');
    expect(parsed.error.code).toBe('AUTH_EXPIRED');
  });
});

describe('auth login — non-TTY no-credentials path', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-login-nocreds-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    vi.doMock('conf', () => {
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: () => false,
        get store() {
          return {};
        },
        set store(_: unknown) {},
      }));
      return { default: ConfMock };
    });

    vi.resetModules();

    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    process.env['FREELO_NO_KEYCHAIN'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_NO_KEYCHAIN'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('exits with code 3 when no credential source is available on non-TTY', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runLogin(run);
    expect(exitCode).toBe(3);
  });

  it('emits AUTH_MISSING on stderr', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr } = await runLogin(run);
    const parsed = parseFirstJson(stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('AUTH_MISSING');
  });
});

describe('auth login — --api-key-stdin without --email exits 2', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-login-stdin-noemail-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    vi.doMock('conf', () => {
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: () => false,
        get store() {
          return {};
        },
        set store(_: unknown) {},
      }));
      return { default: ConfMock };
    });

    vi.resetModules();

    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    process.env['FREELO_NO_KEYCHAIN'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_NO_KEYCHAIN'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('exits with code 2 when --api-key-stdin is used without --email', async () => {
    // Mock stdin to produce an empty/immediate-end response
    const stdinMock = {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'end') setImmediate(() => handler());
        return process.stdin;
      },
      removeListener: () => process.stdin,
    };
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdinMock as unknown as typeof process.stdin);

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runLogin(run, ['--api-key-stdin']);
    expect(exitCode).toBe(2);
  });
});

describe('auth login — 5xx exits 4', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-login-5xx-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    vi.doMock('conf', () => {
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: () => false,
        get store() {
          return {};
        },
        set store(_: unknown) {},
      }));
      return { default: ConfMock };
    });

    vi.resetModules();

    process.env['FREELO_API_KEY'] = 'sk-test';
    process.env['FREELO_EMAIL'] = 'agent@example.cz';
    process.env['FREELO_NO_KEYCHAIN'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });

    server.use(usersMeHandlers.serverError(500));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    delete process.env['FREELO_NO_KEYCHAIN'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('exits with code 4 on 5xx error', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runLogin(run);
    expect(exitCode).toBe(4);
  });
});

describe('auth login — network failure exits 5', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-login-net-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    vi.doMock('conf', () => {
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: () => false,
        get store() {
          return {};
        },
        set store(_: unknown) {},
      }));
      return { default: ConfMock };
    });

    vi.resetModules();

    process.env['FREELO_API_KEY'] = 'sk-test';
    process.env['FREELO_EMAIL'] = 'agent@example.cz';
    process.env['FREELO_NO_KEYCHAIN'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });

    const { http, HttpResponse } = await import('msw');
    server.use(http.get('https://api.freelo.io/v1/users/me', () => HttpResponse.error()));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    delete process.env['FREELO_NO_KEYCHAIN'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('exits with code 5 on network failure', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runLogin(run);
    expect(exitCode).toBe(5);
  });
});

describe('auth login — --api-key-stdin with valid key', () => {
  let testDir: string;
  let storeData: Record<string, unknown>;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-login-stdin-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });

    storeData = {};
    vi.doMock('conf', () => {
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: (key: string) => key in storeData,
        get store() {
          return { ...storeData };
        },
        set store(val: Record<string, unknown>) {
          for (const k of Object.keys(storeData)) delete storeData[k];
          Object.assign(storeData, val);
        },
      }));
      return { default: ConfMock };
    });

    // Mock readStdinToString to return a valid API key
    vi.doMock('../../../src/lib/stdin.js', () => ({
      readStdinToString: vi.fn().mockResolvedValue('sk-from-stdin'),
    }));

    vi.resetModules();

    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    process.env['FREELO_NO_KEYCHAIN'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });

    server.use(usersMeHandlers.ok());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    delete process.env['FREELO_NO_KEYCHAIN'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('logs in successfully via --api-key-stdin --email', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runLogin(run, [
      '--email',
      'stdin@example.cz',
      '--api-key-stdin',
    ]);
    const parsed = parseFirstJson(stdout) as {
      schema: string;
      data: { email: string; user_id: number };
    };
    expect(parsed.schema).toBe('freelo.auth.login/v1');
    expect(parsed.data.email).toBe('stdin@example.cz');
    expect(parsed.data.user_id).toBe(12345);
    expect(exitCode).toBe(0);
  });
});

describe('auth login — --api-key-stdin with empty stdin', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-login-stdin-empty-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    vi.doMock('conf', () => {
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: () => false,
        get store() {
          return {};
        },
        set store(_: unknown) {},
      }));
      return { default: ConfMock };
    });

    // Mock readStdinToString to return empty string (no key)
    vi.doMock('../../../src/lib/stdin.js', () => ({
      readStdinToString: vi.fn().mockResolvedValue(''),
    }));

    vi.resetModules();

    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    process.env['FREELO_NO_KEYCHAIN'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_NO_KEYCHAIN'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('exits with code 2 when stdin produces an empty API key', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runLogin(run, ['--email', 'user@example.cz', '--api-key-stdin']);
    expect(exitCode).toBe(2);
  });

  it('emits VALIDATION_ERROR when stdin produces an empty key', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr } = await runLogin(run, ['--email', 'user@example.cz', '--api-key-stdin']);
    const parsed = parseFirstJson(stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('auth login — --email mismatch with FREELO_EMAIL', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-login-mismatch-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    vi.doMock('conf', () => {
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: () => false,
        get store() {
          return {};
        },
        set store(_: unknown) {},
      }));
      return { default: ConfMock };
    });

    vi.resetModules();

    process.env['FREELO_API_KEY'] = 'sk-test';
    process.env['FREELO_EMAIL'] = 'real@example.cz';
    process.env['FREELO_NO_KEYCHAIN'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    delete process.env['FREELO_NO_KEYCHAIN'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('exits with code 2 when --email does not match FREELO_EMAIL', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runLogin(run, ['--email', 'other@example.cz']);
    expect(exitCode).toBe(2);
  });

  it('emits VALIDATION_ERROR on email mismatch', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr } = await runLogin(run, ['--email', 'other@example.cz']);
    const parsed = parseFirstJson(stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('auth login — interactive TTY path', () => {
  let testDir: string;
  let storeData: Record<string, unknown>;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-login-tty-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });

    storeData = {};
    vi.doMock('conf', () => {
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: (key: string) => key in storeData,
        get store() {
          return { ...storeData };
        },
        set store(val: Record<string, unknown>) {
          for (const k of Object.keys(storeData)) delete storeData[k];
          Object.assign(storeData, val);
        },
      }));
      return { default: ConfMock };
    });

    // Mock @inquirer/prompts to return preset values
    vi.doMock('@inquirer/prompts', () => ({
      input: vi.fn().mockResolvedValue('tty@example.cz'),
      password: vi.fn().mockResolvedValue('sk-from-tty'),
    }));

    // Mock ora to avoid TTY spinner side-effects
    vi.doMock('ora', () => ({
      default: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        text: '',
      })),
    }));

    vi.resetModules();

    // No env credentials — forces interactive branch
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    process.env['FREELO_NO_KEYCHAIN'] = '1';
    // Mark both stdout and stdin as TTY so isInteractive() returns true
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    delete process.env['CI'];

    server.use(usersMeHandlers.ok());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    delete process.env['FREELO_NO_KEYCHAIN'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('logs in via interactive prompts when no env credentials are set', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runLogin(run);
    expect(exitCode).toBe(0);
    const parsed = parseFirstJson(stdout) as {
      schema: string;
      data: { email: string; user_id: number };
    };
    expect(parsed.schema).toBe('freelo.auth.login/v1');
    expect(parsed.data.email).toBe('tty@example.cz');
    expect(parsed.data.user_id).toBe(12345);
  });

  it('prompts for email when --email is not passed', async () => {
    const inquirer = await import('@inquirer/prompts');
    const { run } = await import('../../../src/bin/freelo.js');
    await runLogin(run);
    expect(inquirer.input).toHaveBeenCalled();
  });

  it('uses --email flag and skips the email prompt when --email is provided', async () => {
    const inquirer = await import('@inquirer/prompts');
    // Override input to fail if called unexpectedly
    vi.mocked(inquirer.input).mockRejectedValue(new Error('input should not be called'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runLogin(run, ['--email', 'provided@example.cz']);
    expect(exitCode).toBe(0);
    // input() should NOT have been called because --email was provided
    expect(inquirer.input).not.toHaveBeenCalled();
  });
});

describe('auth login — human mode output', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-login-human-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    vi.doMock('conf', () => {
      const data: Record<string, unknown> = {};
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: (key: string) => key in data,
        get store() {
          return { ...data };
        },
        set store(val: Record<string, unknown>) {
          for (const k of Object.keys(data)) delete data[k];
          Object.assign(data, val);
        },
      }));
      return { default: ConfMock };
    });

    vi.resetModules();

    process.env['FREELO_API_KEY'] = 'sk-test';
    process.env['FREELO_EMAIL'] = 'agent@example.cz';
    process.env['FREELO_NO_KEYCHAIN'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });

    server.use(usersMeHandlers.ok());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    delete process.env['FREELO_NO_KEYCHAIN'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('outputs Logged in as message in human mode', async () => {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`EXIT:${_code ?? 0}`);
    });

    const { run } = await import('../../../src/bin/freelo.js');

    try {
      await run(['node', 'freelo', 'auth', 'login', '--output', 'human']);
    } catch {
      // may exit 0
    }

    const combined = stdout.join('');
    expect(combined).toContain('Logged in');
  });
});
