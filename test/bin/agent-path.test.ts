import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, usersMeHandlers } from '../msw/handlers.js';

/**
 * Agent-path cold-start smoke test.
 *
 * Proves:
 * 1. Non-TTY + env credentials → exactly one line of stdout, JSON-parseable,
 *    schema === 'freelo.auth.whoami/v1'.
 * 2. @inquirer/prompts, ora, chalk, pino-pretty, and keytar are not activated
 *    on the agent path (whoami never needs prompts, spinners, chalk, or keytar;
 *    login only uses them in interactive TTY mode).
 *
 * Uses vi.mock to intercept lazy imports. The mocks record whether their
 * factory was called, which signals the module was actually imported.
 */

const lazyModuleCallLog: string[] = [];

// These mocks intercept the modules if they are imported at all.
// For whoami on the agent path, none of them should be imported.
vi.mock('@inquirer/prompts', () => {
  lazyModuleCallLog.push('@inquirer/prompts');
  return { input: vi.fn(), password: vi.fn() };
});

vi.mock('ora', () => {
  lazyModuleCallLog.push('ora');
  return { default: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })) };
});

vi.mock('chalk', () => {
  lazyModuleCallLog.push('chalk');
  return {
    default: {
      green: vi.fn((s: string) => s),
      red: vi.fn((s: string) => s),
      bold: vi.fn((s: string) => s),
      dim: vi.fn((s: string) => s),
      cyan: vi.fn((s: string) => s),
    },
  };
});

vi.mock('pino-pretty', () => {
  lazyModuleCallLog.push('pino-pretty');
  return { default: vi.fn(() => ({ write: vi.fn() })) };
});

vi.mock('keytar', () => {
  lazyModuleCallLog.push('keytar');
  return {
    default: { getPassword: vi.fn(), setPassword: vi.fn(), deletePassword: vi.fn() },
    getPassword: vi.fn(),
    setPassword: vi.fn(),
    deletePassword: vi.fn(),
  };
});

describe('agent-path cold-start smoke', () => {
  let testDir: string;

  beforeEach(async () => {
    lazyModuleCallLog.length = 0;

    testDir = join(tmpdir(), `freelo-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

    process.env['FREELO_API_KEY'] = 'sk-agent-test';
    process.env['FREELO_EMAIL'] = 'agent@ci.example.com';
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
      // ignore
    }
  });

  it('writes exactly one non-empty line to stdout when running auth whoami as an agent', async () => {
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`EXIT:${_code ?? 0}`);
    });

    const { run } = await import('../../src/bin/freelo.js');

    try {
      await run(['node', 'freelo', 'auth', 'whoami']);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.startsWith('EXIT:')) throw err;
    }

    const combined = stdoutWrites.join('');
    const lines = combined.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
  });

  it('stdout is JSON-parseable with schema freelo.auth.whoami/v1', async () => {
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`EXIT:${_code ?? 0}`);
    });

    const { run } = await import('../../src/bin/freelo.js');

    try {
      await run(['node', 'freelo', 'auth', 'whoami']);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.startsWith('EXIT:')) throw err;
    }

    const combined = stdoutWrites.join('').trim();
    const parsed = JSON.parse(combined) as { schema: string };
    expect(parsed.schema).toBe('freelo.auth.whoami/v1');
  });

  it('does not activate @inquirer/prompts on the whoami agent path', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`EXIT:${_code ?? 0}`);
    });

    lazyModuleCallLog.length = 0;

    const { run } = await import('../../src/bin/freelo.js');

    try {
      await run(['node', 'freelo', 'auth', 'whoami']);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.startsWith('EXIT:')) throw err;
    }

    // @inquirer/prompts is only used by login in TTY mode, never by whoami
    expect(lazyModuleCallLog).not.toContain('@inquirer/prompts');
  });

  it('does not activate ora on the whoami agent path', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`EXIT:${_code ?? 0}`);
    });

    lazyModuleCallLog.length = 0;

    const { run } = await import('../../src/bin/freelo.js');

    try {
      await run(['node', 'freelo', 'auth', 'whoami']);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.startsWith('EXIT:')) throw err;
    }

    // ora is only used by login in TTY mode (spinner), never by whoami
    expect(lazyModuleCallLog).not.toContain('ora');
  });

  it('does not activate chalk on the whoami agent path', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`EXIT:${_code ?? 0}`);
    });

    lazyModuleCallLog.length = 0;

    const { run } = await import('../../src/bin/freelo.js');

    try {
      await run(['node', 'freelo', 'auth', 'whoami']);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.startsWith('EXIT:')) throw err;
    }

    // chalk is only used in human-mode renderers (styles.ts), never on agent paths
    expect(lazyModuleCallLog).not.toContain('chalk');
  });

  it('does not activate pino-pretty on the whoami agent path', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`EXIT:${_code ?? 0}`);
    });

    lazyModuleCallLog.length = 0;

    const { run } = await import('../../src/bin/freelo.js');

    try {
      await run(['node', 'freelo', 'auth', 'whoami']);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.startsWith('EXIT:')) throw err;
    }

    // pino-pretty is only used for TTY log formatting, never on agent paths
    expect(lazyModuleCallLog).not.toContain('pino-pretty');
  });

  it('does not activate keytar on the whoami agent path when FREELO_NO_KEYCHAIN=1', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`EXIT:${_code ?? 0}`);
    });

    lazyModuleCallLog.length = 0;

    const { run } = await import('../../src/bin/freelo.js');

    try {
      await run(['node', 'freelo', 'auth', 'whoami']);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.startsWith('EXIT:')) throw err;
    }

    // keytar is skipped when FREELO_NO_KEYCHAIN=1 or env credentials are present
    expect(lazyModuleCallLog).not.toContain('keytar');
  });
});
