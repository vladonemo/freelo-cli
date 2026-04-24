import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../../src/bin/freelo.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, '..', '..', 'package.json'), 'utf8')) as {
  version: string;
};

/**
 * Drives the program with the given args, capturing stdout and the
 * "process.exit" Commander triggers for `--version` / `--help`. Mirrors
 * how Commander documents programmatic test usage.
 */
async function runWithArgs(args: readonly string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}> {
  const program = buildProgram();

  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;

  program.exitOverride((err) => {
    exitCode = err.exitCode;
    throw err;
  });
  program.configureOutput({
    writeOut: (str) => {
      stdout += str;
    },
    writeErr: (str) => {
      stderr += str;
    },
  });

  try {
    await program.parseAsync(args as string[], { from: 'user' });
  } catch (err) {
    // Commander throws CommanderError after writing version/help. That's
    // expected; the captured exitCode tells the real story.
    if (!(err && typeof err === 'object' && 'code' in err)) {
      throw err;
    }
  }

  return { stdout, stderr, exitCode };
}

describe('freelo --version', () => {
  it('prints the package.json version when --version is passed', async () => {
    const { stdout, exitCode } = await runWithArgs(['--version']);
    expect(stdout.trim()).toBe(pkg.version);
    expect(exitCode).toBe(0);
  });

  it('prints the package.json version when -V (Commander short flag) is passed', async () => {
    const { stdout, exitCode } = await runWithArgs(['-V']);
    expect(stdout.trim()).toBe(pkg.version);
    expect(exitCode).toBe(0);
  });

  it('prints help that mentions the version flag', async () => {
    const { stdout } = await runWithArgs(['--help']);
    expect(stdout).toContain('-V, --version');
    expect(stdout).toContain('output the version number');
  });

  it('uses the inlined VERSION export consistently', async () => {
    // Sanity: the constant the binary uses agrees with package.json. If a
    // future contributor breaks the inlining, this fires.
    const { VERSION } = await vi.importActual<typeof import('../../src/lib/version.js')>(
      '../../src/lib/version.js',
    );
    expect(VERSION).toBe(pkg.version);
  });
});
