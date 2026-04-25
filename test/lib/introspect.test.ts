/**
 * Unit tests for the Commander tree walker (R02.5).
 *
 * Covers:
 *   - meta attach/read round-trip.
 *   - Container commands (no meta) are skipped, only contributing path prefix.
 *   - Leaf commands are emitted with name = space-joined path.
 *   - Output is sorted by name.
 *   - Flags map to the right `type` strings (boolean, string, string?, string[], number).
 *   - Args carry name/required/variadic/description.
 *   - Auto-generated --help / --version flags are filtered out.
 *   - filterByPath finds an existing leaf and returns undefined for a miss.
 */

import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import {
  attachMeta,
  buildIntrospectData,
  filterByPath,
  readMeta,
  walkProgram,
  type CommandMeta,
} from '../../src/lib/introspect.js';

function makeProgram(): Command {
  const program = new Command();
  program.name('freelo').description('Test CLI');

  // Container 'auth' with two leaves
  const auth = program.command('auth').description('Auth group.');
  const login = auth.command('login').description('Log in.').option('--email <addr>', 'Email.');
  attachMeta(login, {
    outputSchema: 'freelo.auth.login/v1',
    destructive: false,
  });
  const logout = auth.command('logout').description('Log out.');
  attachMeta(logout, { outputSchema: 'freelo.auth.logout/v1', destructive: true });

  // Single-level command 'whoami' with mixed flag types.
  const whoami = program
    .command('whoami')
    .description('Who am I.')
    .option('-v, --verbose', 'verbose toggle')
    .option('--name [name]', 'optional name')
    .option('--tags <tag...>', 'list of tags')
    .option('--count <n>', 'numeric', 5);
  attachMeta(whoami, { outputSchema: 'freelo.auth.whoami/v1', destructive: false });

  // Argument-bearing leaf.
  const set = program.command('set <key> <value>').description('Set a key.');
  attachMeta(set, { outputSchema: 'freelo.config.set/v1', destructive: false });

  return program;
}

describe('attachMeta / readMeta', () => {
  it('round-trips meta on a Commander instance', () => {
    const cmd = new Command('x');
    const meta: CommandMeta = { outputSchema: 'freelo.x.x/v1', destructive: true };
    attachMeta(cmd, meta);
    expect(readMeta(cmd)).toEqual(meta);
  });

  it('returns undefined when no meta has been attached', () => {
    const cmd = new Command('y');
    expect(readMeta(cmd)).toBeUndefined();
  });
});

describe('walkProgram', () => {
  it('returns only leaf commands (containers contribute prefix)', () => {
    const program = makeProgram();
    const out = walkProgram(program);
    const names = out.map((c) => c.name).sort();
    expect(names).toEqual(['auth login', 'auth logout', 'set', 'whoami']);
  });

  it('sorts entries by name ascending', () => {
    const program = makeProgram();
    const out = walkProgram(program);
    const names = out.map((c) => c.name);
    expect(names).toEqual([...names].sort());
  });

  it('does not include containers as their own entries (auth has no meta)', () => {
    const program = makeProgram();
    const out = walkProgram(program);
    expect(out.find((c) => c.name === 'auth')).toBeUndefined();
  });

  it('preserves output_schema and destructive from meta', () => {
    const program = makeProgram();
    const out = walkProgram(program);
    const logout = out.find((c) => c.name === 'auth logout');
    expect(logout?.output_schema).toBe('freelo.auth.logout/v1');
    expect(logout?.destructive).toBe(true);
  });
});

describe('flag type mapping', () => {
  it('boolean flag → type "boolean"', () => {
    const program = makeProgram();
    const whoami = walkProgram(program).find((c) => c.name === 'whoami')!;
    const verbose = whoami.flags.find((f) => f.name === '--verbose');
    expect(verbose?.type).toBe('boolean');
    expect(verbose?.short).toBe('-v');
  });

  it('optional value flag ([arg]) → type "string?"', () => {
    const program = makeProgram();
    const whoami = walkProgram(program).find((c) => c.name === 'whoami')!;
    const name = whoami.flags.find((f) => f.name === '--name');
    expect(name?.type).toBe('string?');
  });

  it('variadic value flag (<arg...>) → type "string[]" and repeatable=true', () => {
    const program = makeProgram();
    const whoami = walkProgram(program).find((c) => c.name === 'whoami')!;
    const tags = whoami.flags.find((f) => f.name === '--tags');
    expect(tags?.type).toBe('string[]');
    expect(tags?.repeatable).toBe(true);
  });

  it('numeric default → type "number"', () => {
    const program = makeProgram();
    const whoami = walkProgram(program).find((c) => c.name === 'whoami')!;
    const count = whoami.flags.find((f) => f.name === '--count');
    expect(count?.type).toBe('number');
  });

  it('required value flag (<arg>) → type "string"', () => {
    const program = makeProgram();
    const login = walkProgram(program).find((c) => c.name === 'auth login')!;
    const email = login.flags.find((f) => f.name === '--email');
    expect(email?.type).toBe('string');
  });

  it('filters out --help and --version', () => {
    const program = makeProgram();
    program.helpOption('-h, --help', 'help');
    const out = walkProgram(program);
    for (const c of out) {
      const names = c.flags.map((f) => f.name);
      expect(names).not.toContain('--help');
      expect(names).not.toContain('--version');
    }
  });

  it('sorts flags within a command by long name', () => {
    const program = makeProgram();
    const whoami = walkProgram(program).find((c) => c.name === 'whoami')!;
    const flagNames = whoami.flags.map((f) => f.name);
    expect(flagNames).toEqual([...flagNames].sort());
  });
});

describe('args extraction', () => {
  it('extracts positional args with name/required/variadic/description', () => {
    const program = makeProgram();
    const set = walkProgram(program).find((c) => c.name === 'set')!;
    expect(set.args).toEqual([
      { name: 'key', required: true, variadic: false, description: '' },
      { name: 'value', required: true, variadic: false, description: '' },
    ]);
  });

  it('returns [] when the command has no positional args', () => {
    const program = makeProgram();
    const logout = walkProgram(program).find((c) => c.name === 'auth logout')!;
    expect(logout.args).toEqual([]);
  });
});

describe('buildIntrospectData', () => {
  it('returns { version, commands } structure', () => {
    const program = makeProgram();
    const data = buildIntrospectData(program, '0.0.1-test');
    expect(data.version).toBe('0.0.1-test');
    expect(Array.isArray(data.commands)).toBe(true);
    expect(data.commands.length).toBeGreaterThan(0);
  });
});

describe('filterByPath', () => {
  it('finds a leaf by space-joined path', () => {
    const program = makeProgram();
    const data = buildIntrospectData(program, '0.0.1');
    const match = filterByPath(data.commands, 'auth login');
    expect(match?.name).toBe('auth login');
  });

  it('returns undefined for an unknown path', () => {
    const program = makeProgram();
    const data = buildIntrospectData(program, '0.0.1');
    expect(filterByPath(data.commands, 'auth nope')).toBeUndefined();
  });

  it('trims whitespace from the requested path', () => {
    const program = makeProgram();
    const data = buildIntrospectData(program, '0.0.1');
    expect(filterByPath(data.commands, '  auth login  ')?.name).toBe('auth login');
  });
});
