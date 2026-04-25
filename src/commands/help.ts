/**
 * `freelo help [command...] [--output json]`
 *
 * Agent-friendly alias for `--introspect`. When `--output json` (or
 * non-TTY auto-resolved to json) we emit the introspect envelope, optionally
 * filtered to a single leaf path. When `--output human` we delegate to
 * Commander's built-in `outputHelp()` so existing help-text behavior is
 * untouched.
 *
 * Exit codes:
 *   0 — success.
 *   2 — `INTROSPECT_UNKNOWN_COMMAND` when the named command path doesn't
 *       resolve to a leaf.
 */

import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { buildEnvelope } from '../ui/envelope.js';
import { buildIntrospectData, filterByPath, type IntrospectData } from '../lib/introspect.js';
import { VERSION } from '../lib/version.js';
import { ValidationError } from '../errors/validation-error.js';
import { handleTopLevelError } from '../errors/handle.js';
import { resolveOutputMode } from '../lib/env.js';

export function registerHelp(program: Command, getConfig: GetAppConfig): void {
  // Commander's program has a default helpCommand; replacing it cleanly is
  // brittle across versions, so we register a sibling `help` subcommand and
  // disable the default. Users still get `freelo --help` (the flag) as the
  // primary human entry.
  program.helpCommand(false);

  program
    .command('help [commandPath...]')
    .description(
      'Print the command tree as JSON (--output json) or as the same text as --help (default).',
    )
    .action((commandPath: string[]) => {
      let mode: 'human' | 'json' | 'ndjson';
      try {
        const appConfig = getConfig();
        mode = appConfig.output.mode;
      } catch {
        // preAction hook may not have fired in some unusual paths — fall back
        // to env-based resolution to keep the behavior agent-safe.
        mode = resolveOutputMode('auto');
      }

      try {
        if (mode === 'human') {
          // Resolve the requested command (if any) and print Commander's
          // built-in help for it. Unknown command path → ValidationError.
          const target = resolveCommandForHelp(program, commandPath);
          target.outputHelp();
          return;
        }

        // ndjson is not supported for introspect output in v1.
        if (mode === 'ndjson') {
          throw new ValidationError(
            "Output mode 'ndjson' is not supported by 'freelo help'. Use --output json.",
            { field: '--output', value: 'ndjson' },
          );
        }

        // json mode — full or scoped envelope.
        const fullData = buildIntrospectData(program, VERSION);
        const data = filterToPath(fullData, commandPath);

        const envelope = buildEnvelope({
          schema: 'freelo.introspect/v1',
          data,
        });

        process.stdout.write(`${JSON.stringify(envelope)}\n`);
      } catch (err: unknown) {
        handleTopLevelError(err, mode);
      }
    });

  // The help subcommand itself has no schema/output. It either prints help
  // (a side effect) or emits the introspect envelope. We do not attach
  // `meta` here — it would muddy the introspect output (recursive entry
  // for the help command itself).
}

/**
 * Resolve a space-separated command path (`['auth', 'login']`) against the
 * live program tree. Returns the matched Command, or throws
 * `ValidationError` with code `INTROSPECT_UNKNOWN_COMMAND`.
 *
 * An empty path resolves to `program` itself (the root).
 */
function resolveCommandForHelp(program: Command, path: readonly string[]): Command {
  let current: Command = program;
  for (const segment of path) {
    const next = current.commands.find((c) => c.name() === segment);
    if (!next) {
      throw new ValidationError(`Unknown command '${path.join(' ')}'.`, {
        field: 'commandPath',
        value: path.join(' '),
        hintNext: "Run 'freelo --introspect' to see all available commands.",
      });
    }
    current = next;
  }
  return current;
}

/**
 * Filter the full introspect data to the named path.
 *
 * Empty path returns the full data unmodified. A leaf path returns just that
 * leaf. A parent-group path (e.g. `'config'`) returns every leaf under that
 * subtree (e.g. `config get`, `config list`, …) — matching what humans expect
 * from `freelo help config --output json`.
 *
 * Unknown path → `ValidationError`.
 */
function filterToPath(data: IntrospectData, path: readonly string[]): IntrospectData {
  if (path.length === 0) return data;
  const wanted = path.join(' ');
  const matches = filterByPath(data.commands, wanted);
  if (matches.length === 0) {
    throw new ValidationError(`Unknown command '${wanted}'.`, {
      field: 'commandPath',
      value: wanted,
      hintNext: "Run 'freelo --introspect' to see all available commands.",
    });
  }
  return {
    version: data.version,
    commands: matches,
  };
}
