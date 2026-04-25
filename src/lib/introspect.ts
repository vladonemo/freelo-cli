/**
 * Command-tree introspection.
 *
 * Walks the live Commander program tree and emits a structured description
 * — one entry per leaf command — for the `freelo.introspect/v1` envelope.
 *
 * Design (per spec 0004):
 *   - Each leaf command file exports `meta: CommandMeta` (mandatory at TS level).
 *   - The leaf's `register*()` function calls `attachMeta(cmd, meta)` so the
 *     walker can read it back from the live Commander instance.
 *   - Container commands (e.g. `auth`, `config`) have no meta. They are walked
 *     as path prefix only — never emitted as their own entry.
 *
 * Pure: no I/O, no async, no human-UX imports. Safe on the agent cold path.
 */

import { type Command, type Option } from 'commander';
import { type SchemaString } from '../ui/envelope.js';

export type CommandMeta = {
  readonly outputSchema: SchemaString;
  readonly destructive: boolean;
};

export type IntrospectArg = {
  name: string;
  required: boolean;
  variadic: boolean;
  description: string;
};

export type IntrospectFlagType = 'boolean' | 'string' | 'string?' | 'string[]' | 'number';

export type IntrospectFlag = {
  name: string;
  short: string | null;
  type: IntrospectFlagType;
  required: boolean;
  description: string;
  repeatable: boolean;
};

export type IntrospectCommand = {
  name: string;
  description: string;
  args: IntrospectArg[];
  flags: IntrospectFlag[];
  output_schema: SchemaString;
  destructive: boolean;
};

export type IntrospectData = {
  version: string;
  commands: IntrospectCommand[];
};

/**
 * Symbol-keyed slot on a Commander `Command` instance carrying the leaf's meta.
 * Using a `Symbol.for` so the walker and the registrar agree even if they
 * resolve to different module instances (vitest module isolation).
 */
const META_SLOT = Symbol.for('freelo.introspect.meta');

/**
 * Attach the leaf's `meta` to a Commander command instance. Called by every
 * leaf-command `register*()` function. Returns the same command for chaining.
 */
export function attachMeta<T extends Command>(cmd: T, meta: CommandMeta): T {
  (cmd as unknown as Record<symbol, CommandMeta>)[META_SLOT] = meta;
  return cmd;
}

/** Read the leaf meta off a Commander command, or `undefined` if not a leaf. */
export function readMeta(cmd: Command): CommandMeta | undefined {
  return (cmd as unknown as Record<symbol, CommandMeta | undefined>)[META_SLOT];
}

/**
 * Decide a flag's `type` from the Commander `Option`.
 *
 * Rules (mirrors Commander v12 surface):
 *   - boolean: no `<arg>` placeholder, no `[arg]`, not variadic.
 *   - string[]: variadic.
 *   - string?: optional value (`[arg]`).
 *   - number: option has a `parseArg` that produces a number from a number
 *     literal default. Detected by typeof option.defaultValue === 'number'
 *     (we don't have access to the parser source).
 *   - string: required value (`<arg>`), the default.
 */
function inferFlagType(opt: Option): IntrospectFlagType {
  if (opt.variadic) return 'string[]';
  if (opt.required) {
    // Required value — `<arg>` form. Distinguish number from string by default.
    if (typeof opt.defaultValue === 'number') return 'number';
    return 'string';
  }
  if (opt.optional) return 'string?';
  // No `<arg>` and no `[arg]` → boolean toggle.
  return 'boolean';
}

type CommanderInternalArg = {
  name?: () => string;
  required?: boolean;
  variadic?: boolean;
  description?: string;
};

type CommanderInternalCmd = Command & {
  // Commander v12 stores positional args here.
  registeredArguments?: CommanderInternalArg[];
  _args?: CommanderInternalArg[];
};

function extractArgs(cmd: Command): IntrospectArg[] {
  const c = cmd as CommanderInternalCmd;
  const list = c.registeredArguments ?? c._args ?? [];
  return list.map((a) => ({
    name: typeof a.name === 'function' ? a.name() : '',
    required: a.required === true,
    variadic: a.variadic === true,
    description: a.description ?? '',
  }));
}

function extractFlags(cmd: Command): IntrospectFlag[] {
  // The auto-generated `-h, --help` / `-V, --version` options are part of the
  // Commander program but are noise for agents — they're universal. Skip them.
  const HIDDEN = new Set(['--help', '--version']);
  return cmd.options
    .filter((opt) => !HIDDEN.has(opt.long ?? ''))
    .map<IntrospectFlag>((opt) => ({
      name: opt.long ?? opt.flags,
      short: opt.short ?? null,
      type: inferFlagType(opt),
      required: opt.mandatory === true,
      description: opt.description ?? '',
      repeatable: opt.variadic === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Walk the Commander program. Returns one entry per **leaf** command.
 * Entries are sorted by `name` (space-joined path) ASCII ascending so the
 * golden test sees stable output.
 */
export function walkProgram(program: Command): IntrospectCommand[] {
  const out: IntrospectCommand[] = [];
  // Skip the root program itself — the convention is to enumerate
  // subcommands. But if the root has its own action and meta, include it.
  for (const child of program.commands) {
    walk(child, [child.name()], out);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function walk(cmd: Command, path: string[], out: IntrospectCommand[]): void {
  const meta = readMeta(cmd);
  if (meta) {
    out.push({
      name: path.join(' '),
      description: cmd.description() ?? '',
      args: extractArgs(cmd),
      flags: extractFlags(cmd),
      output_schema: meta.outputSchema,
      destructive: meta.destructive,
    });
  }
  for (const child of cmd.commands) {
    walk(child, [...path, child.name()], out);
  }
}

/** Build the `data` payload for the `freelo.introspect/v1` envelope. */
export function buildIntrospectData(program: Command, version: string): IntrospectData {
  return {
    version,
    commands: walkProgram(program),
  };
}

/**
 * Filter the full introspect output to a single command path.
 * Used by `freelo help <cmd> --output json`.
 *
 * Path is space-separated (`'auth login'`, `'config set'`).
 * Returns `undefined` when no command matches.
 */
export function filterByPath(
  commands: readonly IntrospectCommand[],
  path: string,
): IntrospectCommand | undefined {
  const wanted = path.trim();
  return commands.find((c) => c.name === wanted);
}
