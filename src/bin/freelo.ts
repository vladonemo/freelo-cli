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
 */
function isEntryPoint(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  try {
    const entryUrl = pathToFileURL(realpathSync(entryArg)).href;
    return entryUrl === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  run(process.argv).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`freelo: ${message}\n`);
    process.exit(1);
  });
}
