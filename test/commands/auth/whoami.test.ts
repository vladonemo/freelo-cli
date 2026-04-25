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
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
    const code = Number(_code ?? 0);
    // Only capture the FIRST exit code — subsequent calls may be from
    // the outer run() try/catch re-catching the mock's thrown Error.
    if (firstExitCode === undefined) firstExitCode = code;
    throw new Error(`EXIT:${code}`);
  });

  return {
    stdout,
    stderr,
    exitSpy,
    getFirstExitCode: () => firstExitCode,
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    },
  };
}

async function runWhoami(
  runFn: (argv: string[]) => Promise<void>,
  extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { stdout, stderr, getFirstExitCode, restore } = captureOutput();

  try {
    await runFn(['node', 'freelo', 'auth', 'whoami', '--output', 'json', ...extraArgs]);
  } catch {
    // Swallow all errors — the exit code is captured by the mock.
  } finally {
    restore();
  }

  // Use the first exit code captured; default to 0 (success).
  return {
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    exitCode: getFirstExitCode() ?? 0,
  };
}

/** Parse the first valid JSON line from a string (ignoring log lines). */
function parseFirstJson(text: string): unknown {
  const lines = text.split('\n').filter((l) => l.trim().startsWith('{'));
  for (const line of lines) {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      // try next line
    }
  }
  throw new Error(`No valid JSON line found in: ${JSON.stringify(text)}`);
}

describe('auth whoami — env-mode happy path', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-whoami-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  it('emits a freelo.auth.whoami/v1 envelope on stdout', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runWhoami(run);
    const parsed = parseFirstJson(stdout) as { schema: string };
    expect(parsed.schema).toBe('freelo.auth.whoami/v1');
    expect(exitCode).toBe(0);
  });

  it('includes user_id from the API response', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runWhoami(run);
    const parsed = parseFirstJson(stdout) as { data: { user_id: number } };
    expect(parsed.data.user_id).toBe(12345);
  });

  it('has profile_source env when credentials come from env vars', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runWhoami(run);
    const parsed = parseFirstJson(stdout) as { data: { profile_source: string } };
    expect(parsed.data.profile_source).toBe('env');
  });
});

describe('auth whoami — extended fixture includes full_name', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-whoami-ext-${Date.now()}`);
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
    process.env['FREELO_EMAIL'] = 'jane@example.cz';
    process.env['FREELO_NO_KEYCHAIN'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });

    server.use(usersMeHandlers.okExtended());
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

  it('includes full_name in the envelope when the API returns fullname', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runWhoami(run);
    const parsed = parseFirstJson(stdout) as { data: { full_name?: string } };
    expect(parsed.data.full_name).toBe('Jane Doe');
  });

  it('omits full_name when the minimal fixture has no fullname field', async () => {
    server.use(usersMeHandlers.ok());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runWhoami(run);
    const parsed = parseFirstJson(stdout) as { data: Record<string, unknown> };
    expect('full_name' in parsed.data).toBe(false);
  });
});

describe('auth whoami — missing credentials', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-whoami-miss-${Date.now()}`);
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

  it('exits with code 3 when no credentials are available', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runWhoami(run);
    expect(exitCode).toBe(3);
  });

  it('emits AUTH_MISSING code on stderr', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr } = await runWhoami(run);
    const parsed = parseFirstJson(stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('AUTH_MISSING');
  });
});

describe('auth whoami — 401 response', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-whoami-401-${Date.now()}`);
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
    const { exitCode } = await runWhoami(run);
    expect(exitCode).toBe(3);
  });

  it('emits AUTH_EXPIRED code on stderr in json mode', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr } = await runWhoami(run);
    const parsed = parseFirstJson(stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('AUTH_EXPIRED');
  });

  it('error envelope matches freelo.error/v1 schema', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr } = await runWhoami(run);
    const parsed = parseFirstJson(stderr) as { schema: string };
    expect(parsed.schema).toBe('freelo.error/v1');
  });
});

describe('auth whoami — human mode on TTY', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-whoami-human-${Date.now()}`);
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

  it('outputs human-readable text on TTY with --output human', async () => {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`EXIT:${_code ?? 0}`);
    });

    const { run } = await import('../../../src/bin/freelo.js');

    try {
      await run(['node', 'freelo', 'auth', 'whoami', '--output', 'human']);
    } catch {
      // may throw on exit
    }

    const combined = stdout.join('');
    expect(combined).toContain('Profile:');
    expect(combined).toContain('User ID:');
  });
});

describe('auth whoami — profile_source is conf when credentials come from keytar/fallback', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-whoami-conf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });

    // Pre-populate the store with a profile (conf-stored email + apiBaseUrl)
    const storeContent = {
      schemaVersion: 1,
      currentProfile: 'default',
      profiles: {
        default: {
          email: 'stored@example.cz',
          apiBaseUrl: 'https://api.freelo.io/v1',
        },
      },
    };

    vi.doMock('conf', () => {
      let data: Record<string, unknown> = { ...storeContent };
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: (key: string) => key in data,
        get store() {
          return { ...data };
        },
        set store(val: Record<string, unknown>) {
          data = { ...val };
        },
      }));
      return { default: ConfMock };
    });

    // Mock keytar to return a stored token so credentials come from conf-fallback/keytar
    vi.doMock('keytar', () => ({
      default: {
        getPassword: vi.fn().mockResolvedValue('sk-stored-in-keytar'),
        setPassword: vi.fn(),
        deletePassword: vi.fn(),
      },
      getPassword: vi.fn().mockResolvedValue('sk-stored-in-keytar'),
      setPassword: vi.fn(),
      deletePassword: vi.fn(),
    }));

    vi.resetModules();

    // No env credentials — must fall through to keytar
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    delete process.env['FREELO_NO_KEYCHAIN'];

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

  it('has profile_source conf when token comes from keytar', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runWhoami(run);
    expect(exitCode).toBe(0);
    const parsed = parseFirstJson(stdout) as { data: { profile_source: string } };
    expect(parsed.data.profile_source).toBe('conf');
  });
});
