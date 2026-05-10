/**
 * End-to-end tests for `freelo custom-fields create` (R41, spec 0055).
 *
 * Covers:
 *   - Happy path: --project, --name, --type → POST → JSON envelope, exit 0.
 *   - Body round-trip via createOkWhenBody (body has name + type, no uuid by default).
 *   - --uuid threaded into body when supplied.
 *   - --dry-run: no wire call, envelope echoes `would`, exit 0.
 *   - --output human renders the renderer line.
 *   - Validation: missing --project / --name / --type / bad uuids — each exit 2.
 *   - HTTP errors with exit codes (Calibration §2):
 *     401 → exit 3, 403 → exit 4, 402 PlanExceeded → exit 4, 404 → exit 4,
 *     400 with hint rewriting (name/type/uuid/generic), 5xx → exit 4, 429 → exit 6.
 *   - Introspect entry shows output_schema and destructive: false.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, customFieldsCrudHandlers } from '../../msw/handlers.js';

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

const TYPE_TEXT = '2f7bfe3a-c950-470e-b910-95b4caf5dc4f';
const NEW_FIELD_UUID = '11111111-1111-1111-1111-111111111111';

let testDir: string;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => {
  server.close();
});

beforeEach(async () => {
  testDir = join(tmpdir(), `freelo-cf-create-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('freelo custom-fields create — happy paths', () => {
  it('emits success envelope with project_id + custom_field, exit 0', async () => {
    server.use(customFieldsCrudHandlers.createOk(100));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'Severity',
      '--type',
      TYPE_TEXT,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { project_id: number; custom_field: { uuid: string; name: string } };
    };
    expect(env.schema).toBe('freelo.custom-fields.create/v1');
    expect(env.data.project_id).toBe(100);
    expect(env.data.custom_field.name).toBe('Severity');
  });

  it('body shape contains name + type, no uuid by default', async () => {
    let captured: unknown;
    server.use(
      customFieldsCrudHandlers.createOkWhenBody(100, (body) => {
        captured = body;
        return true;
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'Severity',
      '--type',
      TYPE_TEXT,
      '--output',
      'json',
    ]);
    expect(captured).toEqual({ name: 'Severity', type: TYPE_TEXT });
    expect(captured).not.toHaveProperty('uuid');
  });

  it('threads --uuid into body when supplied', async () => {
    let captured: unknown;
    server.use(
      customFieldsCrudHandlers.createOkWhenBody(100, (body) => {
        captured = body;
        return true;
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'Severity',
      '--type',
      TYPE_TEXT,
      '--uuid',
      NEW_FIELD_UUID,
      '--output',
      'json',
    ]);
    expect(captured).toEqual({ name: 'Severity', type: TYPE_TEXT, uuid: NEW_FIELD_UUID });
  });

  it('--dry-run skips the wire call and emits would', async () => {
    // No handler installed — dry-run must not touch the network.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'Severity',
      '--type',
      TYPE_TEXT,
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      dry_run: true;
      data: { project_id: number; would: { method: string; path: string; body: unknown } };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/custom-field/create/100');
    expect(env.data.would.body).toEqual({ name: 'Severity', type: TYPE_TEXT });
  });

  it('--output human renders the create line', async () => {
    server.use(customFieldsCrudHandlers.createOk(100));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'Severity',
      '--type',
      TYPE_TEXT,
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Created custom field "Severity" on project #100');
  });
});

describe('freelo custom-fields create — validation (exit 2)', () => {
  it('missing --project → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'create',
      '--name',
      'X',
      '--type',
      TYPE_TEXT,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('"VALIDATION_ERROR"');
    expect(stderr).toContain('--project');
  });

  it('missing --name → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--type',
      TYPE_TEXT,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--name with whitespace-only value → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      '   ',
      '--type',
      TYPE_TEXT,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('missing --type → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--project zero → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '0',
      '--name',
      'X',
      '--type',
      TYPE_TEXT,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('malformed --type uuid → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--type',
      'not-a-uuid',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('"VALIDATION_ERROR"');
  });

  it('malformed --uuid → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--type',
      TYPE_TEXT,
      '--uuid',
      'bad',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

describe('freelo custom-fields create — HTTP error paths (exit-code assertions)', () => {
  it('401 → AUTH_EXPIRED, exit 3', async () => {
    server.use(customFieldsCrudHandlers.createUnauthorized(100));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--type',
      TYPE_TEXT,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('"AUTH_EXPIRED"');
  });

  it('403 → exit 4 with project-commander hint', async () => {
    server.use(customFieldsCrudHandlers.createForbidden(100));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--type',
      TYPE_TEXT,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('project commander');
  });

  it('402 PlanExceeded → exit 4 with plan hint', async () => {
    server.use(customFieldsCrudHandlers.createPlanExceeded(100));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--type',
      TYPE_TEXT,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('Plan limit');
  });

  it('404 → exit 4 with project-or-type hint', async () => {
    server.use(customFieldsCrudHandlers.createNotFound(100));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--type',
      TYPE_TEXT,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('Project not found');
  });

  it('400 mentioning "name" → name-rejection hint', async () => {
    server.use(customFieldsCrudHandlers.createBadRequest(100, 'Invalid name field'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--type',
      TYPE_TEXT,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('Server rejected --name');
  });

  it('400 mentioning "type" → type-uuid hint', async () => {
    server.use(customFieldsCrudHandlers.createBadRequest(100, 'Invalid type uuid'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--type',
      TYPE_TEXT,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('Server rejected --type');
  });

  it('400 mentioning "uuid" → uuid-conflict hint', async () => {
    server.use(customFieldsCrudHandlers.createBadRequest(100, 'Duplicate uuid'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--type',
      TYPE_TEXT,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('Server rejected --uuid');
  });

  it('400 with generic message (no name/type/uuid keyword) → fallback validation hint', async () => {
    server.use(customFieldsCrudHandlers.createBadRequest(100, 'Bad request'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--type',
      TYPE_TEXT,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('Server-side validation rejected the request');
  });

  it('5xx → exit 4', async () => {
    server.use(customFieldsCrudHandlers.createServerError(100, 503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--type',
      TYPE_TEXT,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('429 → RATE_LIMITED, exit 6', async () => {
    server.use(customFieldsCrudHandlers.createRateLimited(100));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--type',
      TYPE_TEXT,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('"RATE_LIMITED"');
  });
});

describe('freelo custom-fields create — introspect', () => {
  it('introspect entry shows output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema: string; destructive: boolean }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'custom-fields create');
    expect(entry).toBeDefined();
    expect(entry!.output_schema).toBe('freelo.custom-fields.create/v1');
    expect(entry!.destructive).toBe(false);
  });
});
