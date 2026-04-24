import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { Command } from 'commander';
import { VERSION } from '../lib/version.js';
import { handleTopLevelError } from '../errors/handle.js';
import { buildPartialAppConfig, pickFlags } from '../config/resolve.js';
import { type PartialAppConfig } from '../config/schema.js';
import { resolveOutputMode } from '../lib/env.js';

/**
 * Shared AbortController for SIGINT cancellation. Commands receive the signal
 * via `AppConfig` (or directly from the context) so in-flight requests can
 * be cancelled cleanly on Ctrl-C.
 */
const abortController = new AbortController();

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
    .helpOption('-h, --help', 'display help for command')
    // ----- global flags (inherited by every subcommand) -----
    .option(
      '--output <mode>',
      'Output mode: auto (default), human, json, ndjson. auto resolves to json on non-TTY.',
      'auto',
    )
    .option(
      '--color <mode>',
      'Color output: auto (default), never, always. Honors NO_COLOR and FORCE_COLOR.',
      'auto',
    )
    .option('--profile <name>', 'Credential profile to use.', 'default')
    .option(
      '-v, --verbose',
      'Increase verbosity. -v → info, -vv → debug.',
      (_, prev: number) => prev + 1,
      0,
    )
    .option('--request-id <uuid>', 'Override the auto-generated request ID (UUID v4).')
    .option('-y, --yes', 'Skip confirmation prompts for destructive operations.');

  // Auth subcommand — dynamically imported to keep cold-start lean.
  // The actual register() call is synchronous; the import is hoisted at build
  // time by tsup. We do a static import at the top of the commands file.
  // For now, register synchronously from the commands module.
  // (Registered after global flags so subcommands inherit them.)

  return program;
}

/**
 * Resolve the current `PartialAppConfig` from parsed Commander options.
 * Exported so tests can call it without a full parse.
 */
export function resolveConfig(program: Command): PartialAppConfig {
  const opts = program.opts<Record<string, string | number | boolean | undefined>>();
  return buildPartialAppConfig({
    env: process.env,
    flags: pickFlags(opts),
  });
}

export async function run(argv: readonly string[]): Promise<void> {
  // Register auth commands before parsing.
  const { register: registerAuth } = await import('../commands/auth.js');
  const program = buildProgram();
  // Use exitOverride so Commander throws CommanderError instead of calling
  // process.exit. This keeps the process alive for tests and gives us a typed
  // error to inspect (Commander exit codes map to e.exitCode).
  program.exitOverride();
  registerAuth(program);

  try {
    await program.parseAsync(argv as string[]);
  } catch (err: unknown) {
    // Commander throws CommanderError for --help, --version, and parse errors.
    // Help (exitCode 0 or 1, code 'commander.help') and version (exitCode 0,
    // code 'commander.version') are informational exits — suppress them so the
    // CLI process exits cleanly (or the test runner doesn't see process.exit).
    if (err !== null && typeof err === 'object' && 'code' in err) {
      const commanderErr = err as { exitCode: number; code?: string };
      const isHelpOrVersion =
        commanderErr.code === 'commander.help' ||
        commanderErr.code === 'commander.helpDisplayed' ||
        commanderErr.code === 'commander.version';
      if (isHelpOrVersion) return;
    }

    // Genuine error — resolve output mode from parsed opts if possible.
    let mode: 'human' | 'json' | 'ndjson';
    try {
      mode = resolveConfig(program).output.mode;
    } catch {
      mode = resolveOutputMode('auto');
    }
    handleTopLevelError(err, mode);
  }
  // The auth command actions call handleTopLevelError themselves when they
  // catch — this outer try/catch is a last-resort backstop.
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
 * Catastrophic-path error writer. Handles errors thrown *before* the output
 * mode is resolved (e.g. argv parsing throws before `--output` is read).
 *
 * R01 replaces the bootstrap `.catch` with a two-tier handler; the typed-error
 * dispatcher (`handleTopLevelError`) handles post-resolve errors. This
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
  // Register SIGINT handler before parsing; abort any in-flight request.
  process.on('SIGINT', () => {
    abortController.abort();
    process.exit(130);
  });

  run(process.argv).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    writeCatastrophicError(message);
    process.exit(1);
  });
}
