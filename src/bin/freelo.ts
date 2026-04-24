import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { Command } from 'commander';
import { VERSION } from '../lib/version.js';

/**
 * Build the root Commander program. Exported so tests can drive it
 * programmatically without spawning a child process.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('freelo')
    .description('Command-line interface for Freelo.io project management.')
    .version(VERSION, '-V, --version', 'output the version number')
    .helpOption('-h, --help', 'display help for command');

  // Subcommands will be registered here as features land.
  // (intentionally empty in the initial scaffold)

  return program;
}

export async function run(argv: readonly string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv as string[]);
}

/**
 * True when this module is the process entry point (i.e. invoked as the
 * `freelo` binary). False when imported by tests.
 *
 * Exported so tests can exercise the catch branch (unresolvable argv[1]).
 */
export function isEntryPoint(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  try {
    const entryUrl = pathToFileURL(realpathSync(entryArg)).href;
    return entryUrl === import.meta.url;
  } catch {
    return false;
  }
}

/**
 * Catastrophic-path error writer. R01 replaces this with the full
 * `handleTopLevelError` that maps typed errors to exit codes and renders
 * `freelo.error/v1` envelopes in every machine mode. Until then, this
 * narrower version still honors the agent-first contract: non-TTY callers
 * get a parseable envelope on stderr, TTY callers get a clean message.
 */
export function writeCatastrophicError(message: string): void {
  if (process.stdout.isTTY) {
    process.stderr.write(`freelo: ${message}\n`);
    return;
  }
  const envelope = {
    schema: 'freelo.error/v1',
    error: {
      code: 'INTERNAL_ERROR',
      message,
      retryable: false,
    },
  };
  process.stderr.write(`${JSON.stringify(envelope)}\n`);
}

if (isEntryPoint()) {
  run(process.argv).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    writeCatastrophicError(message);
    process.exit(1);
  });
}
