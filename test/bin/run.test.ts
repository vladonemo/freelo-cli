import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../../src/bin/freelo.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, '..', '..', 'package.json'), 'utf8')) as {
  version: string;
};

/**
 * Drives `run()` (the real entry point, not `buildProgram`) with the given
 * args, capturing stdout and suppressing process.exit. Returns the full
 * stdout string.
 *
 * This exercises the dual-program / preAction path that `version.test.ts`
 * misses (it calls `buildProgram` directly). Any regression that causes
 * `--version` or `--help` to print twice will be caught here.
 */
async function runWithCapture(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
    throw new Error(`EXIT:${_code ?? 0}`);
  });

  try {
    await run(['node', 'freelo', ...args]);
  } catch (err) {
    // Commander throws after --version / --help; EXIT: errors from our mock are
    // expected on those paths. Re-throw anything unexpected.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.startsWith('EXIT:') && !isCommanderError(err)) throw err;
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

function isCommanderError(err: unknown): boolean {
  return err !== null && typeof err === 'object' && 'code' in err;
}

describe('run() — --version regression (must not double-print)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the version exactly once when --version is passed to run()', async () => {
    const { stdout } = await runWithCapture(['--version']);
    // Trim trailing newline before splitting so we don't count the empty
    // string after the final newline as a second line.
    const lines = stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(pkg.version);
  });

  it('prints the version exactly once when -V is passed to run()', async () => {
    const { stdout } = await runWithCapture(['-V']);
    const lines = stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(pkg.version);
  });

  it('does not emit the version string more than once in the full stdout', async () => {
    const { stdout } = await runWithCapture(['--version']);
    const occurrences = stdout.split(pkg.version).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('run() — --help regression (must not double-print)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints help exactly once when --help is passed to run()', async () => {
    const { stdout } = await runWithCapture(['--help']);
    // Help text contains "Usage:" exactly once when printed once.
    const usageCount = (stdout.match(/Usage:/g) ?? []).length;
    expect(usageCount).toBe(1);
  });

  it('help output mentions the version flag', async () => {
    const { stdout } = await runWithCapture(['--help']);
    expect(stdout).toContain('-V, --version');
  });
});
