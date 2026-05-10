/**
 * End-to-end tests for `freelo custom-fields list --project <id>` (R40, spec 0054).
 *
 * Read-only flag-driven command. Covers:
 *   - Happy path 200 with two custom-field rows + is_commander true.
 *   - Happy path 200 empty array + is_commander false.
 *   - Nullable custom_fields_types_uuid (defensive .nullable().optional()).
 *   - Validation: missing/zero/negative/non-numeric --project.
 *   - HTTP: 400 (project_id mention + generic), 401, 403, 404, 429, 5xx, network.
 *   - Human mode lines.
 *   - Introspection lists the leaf with the right output_schema.
 *
 * No --dry-run flag (decision 5 — read-only).
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, customFieldsListHandlers } from '../../msw/handlers.js';

const SAMPLE_FIELDS = [
  {
    uuid: '11111111-1111-1111-1111-111111111111',
    name: 'Severity',
    custom_fields_types_uuid: '2f7bfe3a-c950-470e-b910-95b4caf5dc4f',
    project_id: 100,
    author_id: 5,
    date_add: '2025-01-01T00:00:00Z',
    priority: 1,
  },
  {
    uuid: '22222222-2222-2222-2222-222222222222',
    name: 'Story Points',
    custom_fields_types_uuid: 'b1e56fa9-a97a-429b-8ab4-82bebe58933a',
    project_id: 100,
    author_id: 5,
    date_add: '2025-01-02T00:00:00Z',
    priority: 2,
  },
];

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
    /* swallow; exit captured */
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

let testDir: string;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => {
  server.close();
});

beforeEach(async () => {
  testDir = join(tmpdir(), `freelo-cf-list-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('freelo custom-fields list — happy paths', () => {
  it('200 with two rows + is_commander true: envelope carries them', async () => {
    server.use(customFieldsListHandlers.ok(100, SAMPLE_FIELDS, true));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'list',
      '--project',
      '100',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        project_id: number;
        custom_fields: Array<{ uuid: string; name: string }>;
        is_commander: boolean;
      };
    };
    expect(env.schema).toBe('freelo.custom-fields.list/v1');
    expect(env.data.project_id).toBe(100);
    expect(env.data.custom_fields).toHaveLength(2);
    expect(env.data.custom_fields[0]?.name).toBe('Severity');
    expect(env.data.is_commander).toBe(true);
  });

  it('200 with empty + is_commander false: envelope preserves both', async () => {
    server.use(customFieldsListHandlers.okEmpty(200));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'list',
      '--project',
      '200',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { project_id: number; custom_fields: unknown[]; is_commander: boolean };
    };
    expect(env.data.project_id).toBe(200);
    expect(env.data.custom_fields).toEqual([]);
    expect(env.data.is_commander).toBe(false);
  });

  it('200 with null custom_fields_types_uuid: still parses (defensive nullable)', async () => {
    server.use(
      customFieldsListHandlers.ok(
        100,
        [
          {
            uuid: '11111111-1111-1111-1111-111111111111',
            name: 'Orphan',
            custom_fields_types_uuid: null,
            project_id: 100,
            author_id: 5,
            date_add: null,
            priority: null,
          },
        ],
        true,
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'list',
      '--project',
      '100',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        custom_fields: Array<{ custom_fields_types_uuid: string | null; priority: number | null }>;
      };
    };
    expect(env.data.custom_fields[0]?.custom_fields_types_uuid).toBeNull();
    expect(env.data.custom_fields[0]?.priority).toBeNull();
  });

  it('human mode (with rows): trailer + each row on its own line', async () => {
    server.use(customFieldsListHandlers.ok(100, SAMPLE_FIELDS, true));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'list',
      '--project',
      '100',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Project #100');
    expect(stdout).toContain('2 custom field(s)');
    expect(stdout).toContain('is_commander=true');
    expect(stdout).toContain('Severity');
    expect(stdout).toContain('Story Points');
  });

  it('human mode (empty): "no custom fields" + is_commander', async () => {
    server.use(customFieldsListHandlers.okEmpty(200));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'list',
      '--project',
      '200',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Project #200');
    expect(stdout).toContain('no custom fields');
    expect(stdout).toContain('is_commander=false');
  });
});

describe('freelo custom-fields list — validation', () => {
  it('missing --project → exit 2 (VALIDATION_ERROR)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'list',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const blob = stdout + stderr;
    expect(blob).toMatch(/--project is required/);
  });

  it('--project abc → exit 2 (non-numeric)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'list',
      '--project',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--project 0 → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'list',
      '--project',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--project -1 → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'list',
      '--project',
      '-1',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

describe('freelo custom-fields list — HTTP errors', () => {
  it('400 mentioning project_id → exit 4 with project-must-reference hint', async () => {
    server.use(customFieldsListHandlers.badRequest(100, 'Invalid project_id'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'custom-fields',
      'list',
      '--project',
      '100',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const blob = stdout + stderr;
    expect(blob).toMatch(/must reference a project/i);
  });

  it('400 generic → exit 4 with server-validation hint', async () => {
    server.use(customFieldsListHandlers.badRequest(100, 'Some other error.'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'custom-fields',
      'list',
      '--project',
      '100',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const blob = stdout + stderr;
    expect(blob).toMatch(/server-side validation/i);
  });

  it('401 → exit 3 (AUTH_EXPIRED)', async () => {
    server.use(customFieldsListHandlers.unauthorized(100));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'list',
      '--project',
      '100',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
  });

  it('403 → exit 4 with permission hint', async () => {
    server.use(customFieldsListHandlers.forbidden(100));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'custom-fields',
      'list',
      '--project',
      '100',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const blob = stdout + stderr;
    expect(blob).toMatch(/permission/i);
  });

  it('404 → exit 4 with project-not-found hint', async () => {
    server.use(customFieldsListHandlers.notFound(999));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'custom-fields',
      'list',
      '--project',
      '999',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const blob = stdout + stderr;
    expect(blob).toMatch(/project not found/i);
  });

  it('429 → exit 6 (RateLimitedError)', async () => {
    server.use(customFieldsListHandlers.rateLimited(100));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'list',
      '--project',
      '100',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
  });

  it('5xx → exit 4 (FreeloApiError SERVER_ERROR)', async () => {
    server.use(customFieldsListHandlers.serverError(100, 503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'list',
      '--project',
      '100',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('network failure → exit 5 (NetworkError)', async () => {
    server.use(customFieldsListHandlers.networkError(100));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'list',
      '--project',
      '100',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(5);
  });
});

describe('freelo custom-fields list — request-id propagation', () => {
  it('--request-id is forwarded into the response envelope', async () => {
    const reqId = '550e8400-e29b-41d4-a716-446655440000';
    server.use(customFieldsListHandlers.ok(100, SAMPLE_FIELDS, true));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      '--request-id',
      reqId,
      'custom-fields',
      'list',
      '--project',
      '100',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { request_id?: string };
    expect(env.request_id).toBe(reqId);
  });
});

describe('freelo custom-fields list — introspection', () => {
  it('--introspect lists the leaf with the right schema and required --project flag', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{
          name: string;
          output_schema: string;
          destructive: boolean;
          flags: Array<{ name: string }>;
        }>;
      };
    };
    const leaf = env.data.commands.find((c) => c.name === 'custom-fields list');
    expect(leaf).toBeDefined();
    expect(leaf?.output_schema).toBe('freelo.custom-fields.list/v1');
    expect(leaf?.destructive).toBe(false);
    const projectFlag = leaf?.flags.find((f) => f.name === '--project');
    expect(projectFlag).toBeDefined();
  });
});
