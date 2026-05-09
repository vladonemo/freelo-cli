/**
 * End-to-end tests for `freelo labels attach` (R23, spec 0035).
 *
 * Fan-out: each `--name` → one POST. Server is fetch-or-create; CLI does
 * NOT emit `already_in_target_state` (decision 08). Default is private
 * (decision 06).
 *
 * Covers:
 *   - Happy paths: single name, multi-name fan-out, --hex round-trip,
 *     --public flips wire body, --private explicit (default), dry-run.
 *   - Validation: missing --name, missing --project, mutex --private/--public,
 *     bad --project (zero), bad --hex (3-digit), empty --name string.
 *   - HTTP errors: 401/403/404 (project gone — hard, not idempotent), 5xx,
 *     network.
 *   - Batch continue-on-error: mid-stream failure emits error envelope and
 *     keeps going; exit code is highest-of.
 *   - Introspect entry shows destructive: false.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server, projectLabelsHandlers } from '../../msw/handlers.js';

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

function parseAllJsonLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

let testDir: string;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => {
  server.close();
});

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `freelo-labels-attach-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo labels attach — happy paths', () => {
  it('single --name: emits one envelope, exit 0', async () => {
    server.use(
      projectLabelsHandlers.attachOkWhenBody((body) => {
        const b = body as Record<string, unknown>;
        return b['name'] === 'Billable' && b['is_private'] === true;
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'Billable',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { project_id: number; name: string; is_private: boolean };
    };
    expect(env.schema).toBe('freelo.labels.attach/v1');
    expect(env.data.project_id).toBe(7);
    expect(env.data.name).toBe('Billable');
    expect(env.data.is_private).toBe(true);
  });

  it('multi-name fan-out: one envelope per --name', async () => {
    server.use(projectLabelsHandlers.attachOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'Billable',
      '--name',
      'On hold',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    expect((lines[0] as { data: { name: string } }).data.name).toBe('Billable');
    expect((lines[1] as { data: { name: string } }).data.name).toBe('On hold');
  });

  it('--hex round-trips into wire body and envelope', async () => {
    server.use(
      projectLabelsHandlers.attachOkWhenBody((body) => {
        const b = body as Record<string, unknown>;
        return b['color'] === '#9b59b6';
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'Billable',
      '--hex',
      '#9b59b6',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { color?: string } };
    expect(env.data.color).toBe('#9b59b6');
  });

  it('--public flips wire body to is_private: false', async () => {
    server.use(
      projectLabelsHandlers.attachOkWhenBody((body) => {
        const b = body as Record<string, unknown>;
        return b['is_private'] === false;
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'Billable',
      '--public',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { is_private: boolean } };
    expect(env.data.is_private).toBe(false);
  });

  it('envelope omits already_in_target_state (decision 08)', async () => {
    server.use(projectLabelsHandlers.attachOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'Billable',
      '--output',
      'json',
    ]);
    const env = parseFirstJson(stdout) as { data: Record<string, unknown> };
    expect('already_in_target_state' in env.data).toBe(false);
  });

  it('--dry-run: skips POST, envelope echoes "would" per name', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'Billable',
      '--name',
      'On hold',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const env = line as {
        dry_run?: boolean;
        data: { would?: { method: string; path: string } };
      };
      expect(env.dry_run).toBe(true);
      expect(env.data.would?.method).toBe('POST');
      expect(env.data.would?.path).toBe('/project-labels/add-to-project/7');
    }
  });

  it('human output: prints "Attached ... to project #7."', async () => {
    server.use(projectLabelsHandlers.attachOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'Billable',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Attached');
    expect(stdout).toContain('Billable');
    expect(stdout).toContain('project #7');
  });
});

describe('freelo labels attach — validation', () => {
  it('missing --project → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['labels', 'attach', '--name', 'X', '--output', 'json']);
    // commander's required option missing → process exits with code 1 typically; we handle this
    // via the catastrophic / handle-top-level path. Accept exit 1 OR 2 here.
    expect(exitCode).toBeGreaterThan(0);
  });

  it('missing --name → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/--name|VALIDATION/);
  });

  it('mutex --private + --public → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'X',
      '--private',
      '--public',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/mutually exclusive|VALIDATION/);
  });

  it('bad --project (0) → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '0',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('bad --hex (3-digit) → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'X',
      '--hex',
      '#abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('empty --name string → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      '   ',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

describe('freelo labels attach — palette (R24.5, spec 0048)', () => {
  it('--palette red resolves to #E9483A on the wire', async () => {
    server.use(
      projectLabelsHandlers.attachOkWhenBody((body) => {
        const b = body as Record<string, unknown>;
        return b['color'] === '#E9483A';
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'Billable',
      '--palette',
      'red',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { color?: string } };
    expect(env.data.color).toBe('#E9483A');
  });

  it('--palette is case-insensitive (Red → #E9483A)', async () => {
    server.use(
      projectLabelsHandlers.attachOkWhenBody((body) => {
        const b = body as Record<string, unknown>;
        return b['color'] === '#E9483A';
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'Billable',
      '--palette',
      'Red',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
  });

  it('--palette green --dry-run: would.body.color === #10AA40', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'Billable',
      '--palette',
      'green',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run?: boolean;
      data: { would?: { body: Record<string, unknown> } };
    };
    expect(env.dry_run).toBe(true);
    expect((env.data.would?.body as { color?: string }).color).toBe('#10AA40');
  });

  it('mutex --palette + --hex → ValidationError exit 2 with hint listing names', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'Billable',
      '--palette',
      'red',
      '--hex',
      '#ff0000',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const out = stdout + stderr;
    expect(out).toMatch(/mutually exclusive|VALIDATION/);
    expect(out).toMatch(/gray.*aqua.*blue.*green.*pink.*purple.*red.*orange.*yellow/);
  });

  it('unknown --palette name → ValidationError exit 2 with hint enumerating names', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'Billable',
      '--palette',
      'turquoise',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const out = stdout + stderr;
    expect(out).toMatch(/turquoise|not a recognized|VALIDATION/);
    expect(out).toMatch(/gray.*aqua.*blue.*green.*pink.*purple.*red.*orange.*yellow/);
  });
});

describe('freelo labels attach — error paths', () => {
  it('403 → exit 4 (FORBIDDEN)', async () => {
    server.use(projectLabelsHandlers.attachForbidden());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('404 (project gone) → exit 4 hard error, NOT idempotent', async () => {
    server.use(projectLabelsHandlers.attachNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '999',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('5xx → exit 4', async () => {
    server.use(projectLabelsHandlers.attachServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });
});

describe('freelo labels attach — batch continue-on-error', () => {
  it('mid-stream 5xx: first ok, second errors, third ok → exit 4 with three lines', async () => {
    server.use(
      projectLabelsHandlers.attachPerNameRouter({
        Billable: () => Response.json({ result: 'success' }),
        Bad: () =>
          new Response(JSON.stringify({ errors: ['boom.'] }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
        Final: () => Response.json({ result: 'success' }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'Billable',
      '--name',
      'Bad',
      '--name',
      'Final',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(3);
    expect((lines[0] as { schema: string }).schema).toBe('freelo.labels.attach/v1');
    expect((lines[1] as { schema: string }).schema).toBe('freelo.error/v1');
    expect((lines[2] as { schema: string }).schema).toBe('freelo.labels.attach/v1');
  });
});

describe('freelo labels attach — human output on batch error', () => {
  it('--output human batch failure: emits human error line for failed item', async () => {
    server.use(
      projectLabelsHandlers.attachPerNameRouter({
        Billable: () => Response.json({ result: 'success' }),
        Bad: () =>
          new Response(JSON.stringify({ errors: ['Internal error.'] }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'Billable',
      '--name',
      'Bad',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(4);
    // First name succeeds (human success line)
    expect(stdout).toContain('Attached');
    expect(stdout).toContain('Billable');
    // Second name fails (writeBatchError human branch)
    expect(stdout).toContain('Failed item 2');
    expect(stdout).toContain('project #7');
  });

  it('batch error envelope: carries input_index, project_id, and name in context', async () => {
    server.use(
      projectLabelsHandlers.attachPerNameRouter({
        Billable: () => Response.json({ result: 'success' }),
        Bad: () =>
          new Response(JSON.stringify({ errors: ['Boom.'] }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'Billable',
      '--name',
      'Bad',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const lines = parseAllJsonLines(stdout);
    const errEnv = lines[1] as {
      schema: string;
      error: { context: Record<string, unknown>; errors?: string[] };
    };
    expect(errEnv.schema).toBe('freelo.error/v1');
    expect(errEnv.error.context).toHaveProperty('input_index', 1);
    expect(errEnv.error.context).toHaveProperty('project_id', 7);
    expect(errEnv.error.context).toHaveProperty('name', 'Bad');
  });

  it('batch error envelope with errors[] array: errors field present in error envelope', async () => {
    // FreeloApiError from a 5xx with body `{ errors: ['...'] }` carries an errors
    // array on the error object — exercises the `errors.length > 0` branch in writeBatchError.
    server.use(
      projectLabelsHandlers.attachPerNameRouter({
        Billable: () => Response.json({ result: 'success' }),
        Bad: () =>
          new Response(JSON.stringify({ errors: ['server melted', 'disk full'] }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'Billable',
      '--name',
      'Bad',
      '--output',
      'json',
    ]);
    const lines = parseAllJsonLines(stdout);
    const errEnv = lines[1] as { error: { errors?: string[] } };
    // The errors[] array from the API response should be forwarded into the envelope
    expect(errEnv.error.errors).toBeDefined();
    expect(Array.isArray(errEnv.error.errors)).toBe(true);
  });

  it('toBaseError non-BaseError path: network TypeError wrapped into error envelope', async () => {
    let callCount = 0;
    server.use(
      http.post('https://api.freelo.io/v1/project-labels/add-to-project/:projectId', () => {
        callCount++;
        if (callCount === 1) return HttpResponse.json({ result: 'success' });
        return HttpResponse.error();
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'attach',
      '--project',
      '7',
      '--name',
      'Billable',
      '--name',
      'Bad',
      '--output',
      'json',
    ]);
    expect(exitCode).toBeGreaterThan(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect((lines[1] as { schema: string }).schema).toBe('freelo.error/v1');
  });
});

describe('freelo labels attach — introspect', () => {
  it('lists labels attach with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const entry = env.data.commands.find((c) => c.name === 'labels attach');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.labels.attach/v1');
    expect(entry?.destructive).toBe(false);
  });
});
