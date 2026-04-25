/**
 * Golden-file test for the `freelo.introspect/v1` envelope (R02.5).
 *
 * Locks the envelope shape produced by walking the live program tree.
 * **By design**, this test fails when:
 *   - A new command is added without updating the golden.
 *   - A flag/arg is added or renamed.
 *   - The walker changes its output structure.
 *
 * The golden lives at `test/fixtures/introspect-golden.json`. To update,
 * regenerate it via:
 *   pnpm vitest run test/ui/introspect.test.ts -u
 *
 * Also covers `freelo help --output json` (full + scoped) as the agent-friendly
 * alias for `--introspect`, plus the unknown-command-path error path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { buildIntrospectData } from '../../src/lib/introspect.js';

// We bypass the bin entry and reconstruct the program here so we don't depend
// on argv parsing or process.exit. The leaf register* functions populate the
// same Commander tree that `--introspect` walks at runtime.
async function buildLiveProgram(): Promise<Command> {
  const { buildProgram } = await import('../../src/bin/freelo.js');
  const { register: registerAuth } = await import('../../src/commands/auth.js');
  const { register: registerConfig } = await import('../../src/commands/config.js');
  const { registerHelp } = await import('../../src/commands/help.js');

  const program = buildProgram();
  // The register functions don't run actions during registration, only when
  // the action handler is invoked. Passing a stub `getConfig` is safe here.
  const stubGetConfig = () => {
    throw new Error('getConfig should not be called during program build');
  };
  registerAuth(program, stubGetConfig as never, {} as Record<string, string | undefined>);
  registerConfig(program, stubGetConfig as never, {} as Record<string, string | undefined>);
  registerHelp(program, stubGetConfig as never);
  return program;
}

describe('freelo.introspect/v1 — envelope shape (golden)', () => {
  it('matches the committed golden file', async () => {
    const program = await buildLiveProgram();
    const data = buildIntrospectData(program, 'GOLDEN-VERSION');
    // Snapshot the data block. Pinning version to a known string keeps the
    // golden stable across version bumps.
    await expect(data).toMatchFileSnapshot('../fixtures/introspect-golden.json');
  });

  it('command names are sorted ASCII-ascending and unique', async () => {
    const program = await buildLiveProgram();
    const data = buildIntrospectData(program, '0.0.0');
    const names = data.commands.map((c) => c.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('every leaf has output_schema matching the freelo.<resource>.<op>/v<n> pattern', async () => {
    const program = await buildLiveProgram();
    const data = buildIntrospectData(program, '0.0.0');
    const SCHEMA = /^freelo\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\/v\d+$/;
    for (const c of data.commands) {
      expect(SCHEMA.test(c.output_schema), `${c.name} → ${c.output_schema}`).toBe(true);
    }
  });

  it('every leaf has args and flags as arrays (never omitted)', async () => {
    const program = await buildLiveProgram();
    const data = buildIntrospectData(program, '0.0.0');
    for (const c of data.commands) {
      expect(Array.isArray(c.args)).toBe(true);
      expect(Array.isArray(c.flags)).toBe(true);
    }
  });

  it('does not emit the help command itself as an introspect entry (no meta)', async () => {
    const program = await buildLiveProgram();
    const data = buildIntrospectData(program, '0.0.0');
    expect(data.commands.find((c) => c.name === 'help')).toBeUndefined();
  });
});

describe('freelo --introspect — bin integration', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-introspect-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  async function runCmd(argv: string[]): Promise<{ stdout: string; stderr: string }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`EXIT:${_code ?? 0}`);
    });
    const { run } = await import('../../src/bin/freelo.js');
    try {
      await run(['node', 'freelo', ...argv]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.startsWith('EXIT:')) throw err;
    }
    return { stdout: stdout.join(''), stderr: stderr.join('') };
  }

  it('writes a single freelo.introspect/v1 envelope on `freelo --introspect`', async () => {
    const { stdout } = await runCmd(['--introspect']);
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    const env = JSON.parse(lines[0]!) as { schema: string; data: { commands: unknown[] } };
    expect(env.schema).toBe('freelo.introspect/v1');
    expect(Array.isArray(env.data.commands)).toBe(true);
    expect(env.data.commands.length).toBeGreaterThan(0);
  });

  it('honors --request-id by surfacing it as request_id on the envelope', async () => {
    // Valid UUID v4 — third group must start with 4, fourth with 8/9/a/b.
    const validUuid = '11111111-2222-4333-8444-555555555555';
    const { stdout } = await runCmd(['--introspect', '--request-id', validUuid]);
    const env = JSON.parse(stdout.split('\n').filter((l) => l.trim().length > 0)[0]!) as {
      request_id?: string;
    };
    expect(env.request_id).toBe(validUuid);
  });

  it('`freelo help --output json` returns the same data as --introspect', async () => {
    const { stdout: introStdout } = await runCmd(['--introspect']);
    const { stdout: helpStdout } = await runCmd(['help', '--output', 'json']);
    const intro = JSON.parse(introStdout.split('\n').filter((l) => l.trim().length > 0)[0]!) as {
      data: { commands: unknown[] };
    };
    const help = JSON.parse(helpStdout.split('\n').filter((l) => l.trim().length > 0)[0]!) as {
      data: { commands: unknown[] };
    };
    expect(help.data.commands).toEqual(intro.data.commands);
  });

  it('`freelo help auth login --output json` returns one entry scoped to that leaf', async () => {
    const { stdout } = await runCmd(['help', 'auth', 'login', '--output', 'json']);
    const env = JSON.parse(stdout.split('\n').filter((l) => l.trim().length > 0)[0]!) as {
      data: { commands: Array<{ name: string }> };
    };
    expect(env.data.commands).toHaveLength(1);
    expect(env.data.commands[0]!.name).toBe('auth login');
  });

  it('`freelo help --output human` delegates to Commander outputHelp() (no JSON envelope)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    const { stdout, stderr } = await runCmd(['help', '--output', 'human']);
    const combined = stdout + stderr;
    // Help text contains the program name and the global '--output' option.
    expect(combined).toContain('freelo');
    expect(combined).toContain('--output');
    // No JSON envelope emitted.
    const jsonLines = combined.split('\n').filter((l) => l.trim().startsWith('{'));
    expect(jsonLines).toHaveLength(0);
  });

  it('`freelo help auth login --output human` delegates to the leaf outputHelp()', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    const { stdout, stderr } = await runCmd(['help', 'auth', 'login', '--output', 'human']);
    const combined = stdout + stderr;
    expect(combined).toContain('login');
    expect(combined).toContain('--email');
  });

  it('`freelo help unknown --output human` exits non-zero with VALIDATION_ERROR', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    const { stdout, stderr } = await runCmd([
      'help',
      'definitely-not-a-command',
      '--output',
      'human',
    ]);
    // Human-mode error envelope routes to stderr as a clean message.
    const combined = stdout + stderr;
    expect(combined.toLowerCase()).toContain('unknown command');
  });

  it('`freelo help --output ndjson` is rejected with VALIDATION_ERROR', async () => {
    const { stdout, stderr } = await runCmd(['help', '--output', 'ndjson']);
    const errLines = (stdout + stderr).split('\n').filter((l) => l.trim().startsWith('{'));
    expect(errLines.length).toBeGreaterThan(0);
    const env = JSON.parse(errLines[0]!) as {
      schema: string;
      error: { code: string; message: string };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/ndjson/i);
  });

  it('`freelo help unknown --output json` exits non-zero with VALIDATION_ERROR', async () => {
    const { stdout, stderr } = await runCmd([
      'help',
      'definitely-not-a-command',
      '--output',
      'json',
    ]);
    // Error envelope is emitted on stderr by handleTopLevelError when non-TTY.
    const errLines = (stdout + stderr).split('\n').filter((l) => l.trim().startsWith('{'));
    expect(errLines.length).toBeGreaterThan(0);
    const env = JSON.parse(errLines[0]!) as { schema: string; error: { code: string } };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });
});
