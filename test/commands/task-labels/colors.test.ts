/**
 * End-to-end tests for `freelo task-labels colors` (M05, spec 0067).
 *
 * Covers:
 *   - Happy path: envelope shape (`colors[]`, `count`, `default_color`,
 *     `drift`), and the human table renderer.
 *   - `palette_name` — the local `--palette` name for a server hex, `null`
 *     when the server offers a color the CLI has no name for. Distinct from
 *     `display_name`, which the API documents as display-only and does not
 *     accept as input (spec 0067 §3.1(a)).
 *   - **Case-insensitivity**: a fully-current server sends lowercase hex while
 *     `PALETTE` stores uppercase. A case-sensitive compare would report total
 *     drift on day one, so a lowercase nine-color payload must report
 *     `drift.matches === true`. This is the crux assertion of the slice
 *     (spec 0067 §3.1(b)).
 *   - Drift in both directions, and that it is **data, not an error** — exit 0
 *     either way (spec 0067 §5).
 *   - Outbound path is exactly `/task-label-colors` with no query string —
 *     fails loudly if the sibling `/task-labels/find-available` were wired by
 *     mistake. Asserts request *content*; never request counts (MSW resolvers
 *     fire twice per logical request in this repo).
 *   - Exit codes: 401 (3), 5xx (4), malformed body (4), 429 (6), network (5) —
 *     calibration §2.
 *   - Introspect entry shows output_schema and destructive: false.
 *
 * No TTY-prompt path in this command (read-only, no confirmation gate), so
 * calibration §7's `CI`-clearing requirement does not apply — the human-output
 * test drives the renderer through `--output human`, not TTY detection.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, taskLabelsHandlers } from '../../msw/handlers.js';
import { PALETTE } from '../../../src/lib/label-color.js';

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let firstExitCode: number | undefined;
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    const c = Number(code ?? 0);
    if (firstExitCode === undefined) firstExitCode = c;
    throw new Error(`EXIT:${c}`);
  });
  return {
    stdout,
    stderr,
    getFirstExitCode: () => firstExitCode,
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    },
  };
}

async function runCli(
  runFn: (argv: readonly string[]) => Promise<void>,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { stdout, stderr, getFirstExitCode, restore } = captureOutput();
  try {
    await runFn(['node', 'freelo', ...args]);
  } catch {
    /* swallow */
  } finally {
    restore();
  }
  return {
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    exitCode: getFirstExitCode() ?? 0,
  };
}

function parseFirstJson(text: string): Record<string, unknown> {
  const lines = text.split('\n').filter((l) => l.trim().startsWith('{'));
  for (const line of lines) {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      // try next
    }
  }
  throw new Error(`No JSON in: ${text.slice(0, 200)}`);
}

type ColorsEnvelope = {
  schema: string;
  data: {
    colors: Array<{
      color?: string;
      display_name?: string;
      is_default?: boolean;
      palette_name: string | null;
    }>;
    count: number;
    default_color: string | null;
    drift: { matches: boolean; server_only: string[]; local_only: string[] };
  };
};

/* ---------------------------------------------------------------------------
 *  Fixtures — the wire sends LOWERCASE hex (yaml :5964); `PALETTE` stores
 *  uppercase. Using lowercase here is deliberate, not incidental.
 * ------------------------------------------------------------------------- */

const FULL_PALETTE_WIRE = Object.entries(PALETTE).map(([name, hex]) => ({
  color: hex.toLowerCase(),
  display_name: name.charAt(0).toUpperCase() + name.slice(1),
  is_default: name === 'gray',
}));

const GRAY = { color: '#77787a', display_name: 'Gray', is_default: true };
const AQUA = { color: '#15acc0', display_name: 'Aqua', is_default: false };
const UNKNOWN = { color: '#0abcde', display_name: 'Teal', is_default: false };

let testDir: string;

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  // Calibration: the first `await import` in a file pays the full vite
  // transform; charging it to whichever test runs first flakes the 15s
  // testTimeout on a loaded machine.
  await import('../../../src/bin/freelo.js');
}, 60_000);

afterAll(() => {
  server.close();
});

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `freelo-task-labels-colors-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  process.env['FREELO_API_KEY'] = 'sk-test';
  process.env['FREELO_EMAIL'] = 'agent@example.cz';
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
});

afterEach(async () => {
  server.resetHandlers();
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env['FREELO_API_KEY'];
  delete process.env['FREELO_EMAIL'];
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('freelo task-labels colors — happy paths', () => {
  it('emits the envelope with colors[], count and default_color, exit 0', async () => {
    server.use(taskLabelsHandlers.colorsOk([GRAY, AQUA]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['task-labels', 'colors', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as unknown as ColorsEnvelope;
    expect(env.schema).toBe('freelo.task_labels.colors/v1');
    expect(env.data.colors).toHaveLength(2);
    expect(env.data.count).toBe(2);
    expect(env.data.colors[0]!.color).toBe('#77787a');
    expect(env.data.colors[0]!.display_name).toBe('Gray');
    expect(env.data.default_color).toBe('#77787a');
  });

  it('maps a known server hex to its local --palette name, case-insensitively', async () => {
    server.use(taskLabelsHandlers.colorsOk([GRAY, AQUA]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, ['task-labels', 'colors', '--output', 'json']);
    const env = parseFirstJson(stdout) as unknown as ColorsEnvelope;
    expect(env.data.colors[0]!.palette_name).toBe('gray');
    expect(env.data.colors[1]!.palette_name).toBe('aqua');
  });

  it('sets palette_name null for a server color the local table has no name for', async () => {
    server.use(taskLabelsHandlers.colorsOk([UNKNOWN]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, ['task-labels', 'colors', '--output', 'json']);
    const env = parseFirstJson(stdout) as unknown as ColorsEnvelope;
    expect(env.data.colors[0]!.palette_name).toBeNull();
    // display_name is still surfaced — it is just not the --palette name.
    expect(env.data.colors[0]!.display_name).toBe('Teal');
  });

  it('default_color is null when no entry is flagged is_default', async () => {
    server.use(taskLabelsHandlers.colorsOk([AQUA, UNKNOWN]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['task-labels', 'colors', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as unknown as ColorsEnvelope;
    expect(env.data.default_color).toBeNull();
  });

  it('an empty palette is a success, not an error', async () => {
    server.use(taskLabelsHandlers.colorsOk([]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['task-labels', 'colors', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as unknown as ColorsEnvelope;
    expect(env.data.count).toBe(0);
    expect(env.data.default_color).toBeNull();
  });

  it('requests exactly GET /task-label-colors with no query string', async () => {
    const seen: string[] = [];
    server.use(taskLabelsHandlers.colorsOkCapturing(seen, [GRAY]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['task-labels', 'colors', '--output', 'json']);
    expect(exitCode).toBe(0);
    // Assert content, never counts — MSW resolvers fire twice per logical
    // request in this repo.
    const url = new URL(seen[0]!);
    expect(url.pathname.endsWith('/task-label-colors')).toBe(true);
    expect(url.search).toBe('');
    expect(url.pathname).not.toContain('find-available');
  });
});

describe('freelo task-labels colors — drift reporting', () => {
  it('reports no drift when the server sends the nine local colors in lowercase', async () => {
    server.use(taskLabelsHandlers.colorsOk(FULL_PALETTE_WIRE));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['task-labels', 'colors', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as unknown as ColorsEnvelope;
    expect(env.data.count).toBe(9);
    expect(env.data.drift.matches).toBe(true);
    expect(env.data.drift.server_only).toEqual([]);
    expect(env.data.drift.local_only).toEqual([]);
    expect(env.data.colors.every((c) => c.palette_name !== null)).toBe(true);
  });

  it('lists a new server color under drift.server_only, still exit 0', async () => {
    server.use(taskLabelsHandlers.colorsOk([...FULL_PALETTE_WIRE, UNKNOWN]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['task-labels', 'colors', '--output', 'json']);
    // Drift is data, not an error.
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as unknown as ColorsEnvelope;
    expect(env.data.drift.matches).toBe(false);
    expect(env.data.drift.server_only).toEqual(['#0abcde']);
    expect(env.data.drift.local_only).toEqual([]);
  });

  it('lists a retired local palette NAME under drift.local_only', async () => {
    server.use(taskLabelsHandlers.colorsOk(FULL_PALETTE_WIRE.filter((c) => c.color !== '#15acc0')));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['task-labels', 'colors', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as unknown as ColorsEnvelope;
    expect(env.data.drift.matches).toBe(false);
    expect(env.data.drift.local_only).toEqual(['aqua']);
    expect(env.data.drift.server_only).toEqual([]);
  });

  it('an empty palette is total drift, but still exit 0', async () => {
    server.use(taskLabelsHandlers.colorsOk([]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['task-labels', 'colors', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as unknown as ColorsEnvelope;
    expect(env.data.drift.matches).toBe(false);
    expect(env.data.drift.local_only).toHaveLength(9);
  });
});

describe('freelo task-labels colors — human output', () => {
  it('renders the hex, the palette name, the display name and the default marker', async () => {
    server.use(taskLabelsHandlers.colorsOk([GRAY, AQUA]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['task-labels', 'colors', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('#77787a');
    expect(stdout).toContain('gray');
    expect(stdout).toContain('Gray');
    expect(stdout).toContain('DISPLAY NAME');
    expect(stdout).toContain('yes');
  });

  it('stays silent about drift when the tables agree', async () => {
    server.use(taskLabelsHandlers.colorsOk(FULL_PALETTE_WIRE));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, ['task-labels', 'colors', '--output', 'human']);
    expect(stdout).not.toContain('Drift:');
  });

  it('appends a drift footer naming both directions when they disagree', async () => {
    server.use(
      taskLabelsHandlers.colorsOk([
        ...FULL_PALETTE_WIRE.filter((c) => c.color !== '#15acc0'),
        UNKNOWN,
      ]),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, ['task-labels', 'colors', '--output', 'human']);
    expect(stdout).toContain('Drift:');
    expect(stdout).toContain('#0abcde');
    expect(stdout).toContain('--hex');
    expect(stdout).toContain('aqua');
  });

  it('names only the server-only direction when that is the only drift', async () => {
    server.use(taskLabelsHandlers.colorsOk([...FULL_PALETTE_WIRE, UNKNOWN]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, ['task-labels', 'colors', '--output', 'human']);
    expect(stdout).toContain('Drift:');
    expect(stdout).toContain('#0abcde');
    expect(stdout).not.toContain('not returned by the server');
  });

  it('names only the local-only direction when that is the only drift', async () => {
    server.use(taskLabelsHandlers.colorsOk(FULL_PALETTE_WIRE.filter((c) => c.color !== '#15acc0')));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, ['task-labels', 'colors', '--output', 'human']);
    expect(stdout).toContain('Drift:');
    expect(stdout).toContain('not returned by the server');
    expect(stdout).not.toContain('no --palette name');
  });

  it('renders a placeholder row for an empty palette', async () => {
    server.use(taskLabelsHandlers.colorsOk([]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['task-labels', 'colors', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(no colors returned)');
  });
});

describe('freelo task-labels colors — request-id propagation', () => {
  it('--request-id is forwarded into the response envelope', async () => {
    server.use(taskLabelsHandlers.colorsOk([GRAY]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'colors',
      '--request-id',
      '11111111-2222-4333-8444-555555555555',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { request_id?: string };
    expect(env.request_id).toBe('11111111-2222-4333-8444-555555555555');
  });
});

describe('freelo task-labels colors — error paths (calibration §2 exit codes)', () => {
  it('401 → AUTH_EXPIRED, exit 3', async () => {
    server.use(taskLabelsHandlers.colorsUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['task-labels', 'colors', '--output', 'json']);
    expect(exitCode).toBe(3);
    // The structured error envelope goes to stderr; stdout stays sacred.
    const env = parseFirstJson(stderr) as { error?: { code?: string } };
    // 401 is classified as AUTH_EXPIRED, not the generic FREELO_API_ERROR.
    expect(env.error?.code).toBe('AUTH_EXPIRED');
  });

  it('500 → exit 4', async () => {
    server.use(taskLabelsHandlers.colorsServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['task-labels', 'colors', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('malformed body (no colors key) → VALIDATION_ERROR, exit 4', async () => {
    server.use(taskLabelsHandlers.colorsMalformed());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['task-labels', 'colors', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error?: { code?: string } };
    expect(env.error?.code).toBe('VALIDATION_ERROR');
  });

  it('429 → RATE_LIMITED, exit 6', async () => {
    server.use(taskLabelsHandlers.colorsRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['task-labels', 'colors', '--output', 'json']);
    expect(exitCode).toBe(6);
    const env = parseFirstJson(stderr) as { error?: { code?: string } };
    expect(env.error?.code).toBe('RATE_LIMITED');
  });

  it('network failure → NETWORK_ERROR, exit 5', async () => {
    server.use(taskLabelsHandlers.colorsNetworkError());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['task-labels', 'colors', '--output', 'json']);
    expect(exitCode).toBe(5);
    const env = parseFirstJson(stderr) as { error?: { code?: string } };
    expect(env.error?.code).toBe('NETWORK_ERROR');
  });
});

describe('freelo task-labels colors — introspection', () => {
  it('appears in --introspect with its output schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('freelo.task_labels.colors/v1');
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema?: string; destructive?: boolean }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'task-labels colors');
    expect(entry).toBeDefined();
    expect(entry!.output_schema).toBe('freelo.task_labels.colors/v1');
    expect(entry!.destructive).toBe(false);
  });
});
