/**
 * Agent-cold-path test for `freelo --introspect` (R02.5).
 *
 * Mirrors `test/bin/agent-path.test.ts` but exercises the introspect entry.
 * Proves:
 *   1. `freelo --introspect` writes exactly one non-empty stdout line.
 *   2. The output is JSON-parseable with schema 'freelo.introspect/v1'.
 *   3. None of the human-UX deps are loaded on the agent cold path:
 *      `@inquirer/prompts`, `ora`, `chalk`, `pino-pretty`, `keytar`.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lazyModuleCallLog: string[] = [];

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

describe('freelo --introspect — agent cold path', () => {
  let testDir: string;

  beforeEach(async () => {
    lazyModuleCallLog.length = 0;
    testDir = join(
      tmpdir(),
      `freelo-introspect-cold-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
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
      // ignore
    }
  });

  async function invokeIntrospect(): Promise<{ stdout: string }> {
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
      await run(['node', 'freelo', '--introspect']);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.startsWith('EXIT:')) throw err;
    }
    return { stdout: stdoutWrites.join('') };
  }

  it('writes exactly one non-empty stdout line', async () => {
    const { stdout } = await invokeIntrospect();
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
  });

  it('stdout is JSON-parseable with schema freelo.introspect/v1', async () => {
    const { stdout } = await invokeIntrospect();
    const parsed = JSON.parse(stdout.trim()) as { schema: string };
    expect(parsed.schema).toBe('freelo.introspect/v1');
  });

  it('does not activate @inquirer/prompts', async () => {
    lazyModuleCallLog.length = 0;
    await invokeIntrospect();
    expect(lazyModuleCallLog).not.toContain('@inquirer/prompts');
  });

  it('does not activate ora', async () => {
    lazyModuleCallLog.length = 0;
    await invokeIntrospect();
    expect(lazyModuleCallLog).not.toContain('ora');
  });

  it('does not activate chalk', async () => {
    lazyModuleCallLog.length = 0;
    await invokeIntrospect();
    expect(lazyModuleCallLog).not.toContain('chalk');
  });

  it('does not activate pino-pretty', async () => {
    lazyModuleCallLog.length = 0;
    await invokeIntrospect();
    expect(lazyModuleCallLog).not.toContain('pino-pretty');
  });

  it('does not activate keytar', async () => {
    lazyModuleCallLog.length = 0;
    await invokeIntrospect();
    expect(lazyModuleCallLog).not.toContain('keytar');
  });
});
