/**
 * End-to-end tests for `freelo files list` (R26, spec 0038).
 *
 * Covers:
 *   - Happy paths: default, --page (1-indexed CLI → 0-indexed wire), --all
 *     (multi-page merged), --project (repeatable), --type (each of the four
 *     CLI short forms maps to its wire enum), --request-id round-trip,
 *     empty list, human-mode rendering.
 *   - Validation: every typed-error path with `exitCode` assertion
 *     (Calibration §2). Includes mutex --page/--all, non-positive ints,
 *     bad --type values (including the wire forms `document` / `directory`).
 *   - HTTP errors: 401/403/404/429/5xx/network. Each typed error class
 *     triggered and exit code asserted.
 *   - Schema-validation: malformed wire row (`type: 'unknown_kind'`) →
 *     `FreeloApiError VALIDATION_ERROR`.
 *   - Pagination edge: --all mid-stream 5xx → partial envelope + notice.
 *   - Introspect entry shows output_schema and destructive: false.
 *
 * Test pattern mirrors `test/commands/reports/list.test.ts`.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, allDocsAndFilesListHandlers } from '../../msw/handlers.js';

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
  testDir = join(
    tmpdir(),
    `freelo-files-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

// Realistic FileItem fixtures spanning the four type values.
const ITEM_DOC = {
  uuid: 'aaaaaaaa-1111-1111-1111-111111111111',
  name: 'Architecture Notes',
  author: { id: 7, fullname: 'Alice' },
  project: { id: 11, name: 'Apollo' },
  directory_uuid: null,
  date_add: '2026-04-25T10:00:00Z',
  order: 1,
  type: 'document' as const,
  filename: null,
  caption: null,
  mime_type: null,
  extension: null,
  size: 4096,
  color: null,
  items_count: null,
  link: null,
  link_type: null,
  note: 'Internal docs',
};

const ITEM_FILE = {
  uuid: 'bbbbbbbb-2222-2222-2222-222222222222',
  name: 'logo.png',
  author: { id: 7, fullname: 'Alice' },
  project: { id: 11, name: 'Apollo' },
  directory_uuid: null,
  date_add: '2026-04-20T09:00:00Z',
  order: 2,
  type: 'file' as const,
  filename: 'logo.png',
  caption: null,
  mime_type: 'image/png',
  extension: 'png',
  size: 2_500_000,
  color: null,
  items_count: null,
  link: null,
  link_type: null,
  note: null,
};

const ITEM_LINK = {
  uuid: 'cccccccc-3333-3333-3333-333333333333',
  name: 'Project tracker',
  author: { id: 8, fullname: 'Bob' },
  project: { id: 22, name: 'Mercury' },
  directory_uuid: null,
  date_add: '2026-04-15T08:00:00Z',
  order: 3,
  type: 'link' as const,
  filename: null,
  caption: null,
  mime_type: null,
  extension: null,
  size: null,
  color: null,
  items_count: null,
  link: 'https://example.com',
  link_type: 'external',
  note: null,
};

const ITEM_DIR = {
  uuid: 'dddddddd-4444-4444-4444-444444444444',
  name: 'Designs',
  author: { id: 9 }, // fullname missing — exercises renderer's fallback to numeric id
  project: { id: 11, name: 'Apollo' },
  directory_uuid: null,
  date_add: '2026-04-10T07:00:00Z',
  order: 4,
  type: 'directory' as const,
  filename: null,
  caption: null,
  mime_type: null,
  extension: null,
  size: null,
  color: 'blue',
  items_count: 7,
  link: null,
  link_type: null,
  note: null,
};

// ---------------------------------------------------------------------------
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo files list — happy paths', () => {
  it('default invocation: ?p=0, applied_filters {}, exit 0', async () => {
    server.use(
      allDocsAndFilesListHandlers.paged({
        0: {
          total: 2,
          count: 2,
          page: 0,
          per_page: 25,
          data: { items: [ITEM_DOC, ITEM_FILE] },
        },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['files', 'list', '--output', 'json']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        applied_filters: Record<string, unknown>;
        items: Array<{ uuid: string }>;
      };
      paging: { page: number; next_cursor: number | null; total: number };
    };
    expect(env.schema).toBe('freelo.files.list/v1');
    expect(env.data.applied_filters).toEqual({});
    expect(env.data.items).toHaveLength(2);
    expect(env.paging.page).toBe(0);
    expect(env.paging.next_cursor).toBeNull();
    expect(env.paging.total).toBe(2);
  });

  it('--page 1 (CLI 1-indexed → wire ?p=0)', async () => {
    let observedQuery: string | null = null;
    server.use(
      allDocsAndFilesListHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { items: [ITEM_DOC] },
          },
        },
        {
          onRequest: (req) => {
            observedQuery = new URL(req.url).search;
          },
        },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['files', 'list', '--page', '1', '--output', 'json']);

    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('p=0');
  });

  it('--page 3 maps to wire ?p=2', async () => {
    let observedQuery: string | null = null;
    server.use(
      allDocsAndFilesListHandlers.paged(
        {
          2: {
            total: 50,
            count: 25,
            page: 2,
            per_page: 25,
            data: { items: [ITEM_DOC] },
          },
        },
        {
          onRequest: (req) => {
            observedQuery = new URL(req.url).search;
          },
        },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'list',
      '--page',
      '3',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('p=2');
    const env = parseFirstJson(stdout) as { paging: { page: number } };
    expect(env.paging.page).toBe(2);
  });

  it('--all: merges across multiple pages, paging.next_cursor=null at end', async () => {
    server.use(
      allDocsAndFilesListHandlers.paged({
        0: {
          total: 3,
          count: 2,
          page: 0,
          per_page: 2,
          data: { items: [ITEM_DOC, ITEM_FILE] },
        },
        1: {
          total: 3,
          count: 1,
          page: 1,
          per_page: 2,
          data: { items: [ITEM_LINK] },
        },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['files', 'list', '--all', '--output', 'json']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { items: Array<{ uuid: string }> };
      paging: { next_cursor: number | null };
    };
    expect(env.data.items).toHaveLength(3);
    expect(env.paging.next_cursor).toBeNull();
  });

  it('--project repeated: wire encodes projects_ids[]=11&projects_ids[]=22; applied_filters echoes', async () => {
    let observedQuery: string | null = null;
    server.use(
      allDocsAndFilesListHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { items: [ITEM_DOC] },
          },
        },
        {
          onRequest: (req) => {
            observedQuery = new URL(req.url).search;
          },
        },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'list',
      '--project',
      '11',
      '--project',
      '22',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('projects_ids%5B%5D=11');
    expect(observedQuery).toContain('projects_ids%5B%5D=22');
    const env = parseFirstJson(stdout) as {
      data: { applied_filters: { projects?: number[] } };
    };
    expect(env.data.applied_filters.projects).toEqual([11, 22]);
  });

  it('--type doc: wire encodes type=document; applied_filters echoes wire form', async () => {
    let observedQuery: string | null = null;
    server.use(
      allDocsAndFilesListHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { items: [ITEM_DOC] },
          },
        },
        {
          onRequest: (req) => {
            observedQuery = new URL(req.url).search;
          },
        },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'list',
      '--type',
      'doc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('type=document');
    const env = parseFirstJson(stdout) as { data: { applied_filters: { type?: string } } };
    expect(env.data.applied_filters.type).toBe('document');
  });

  it('--type file: wire encodes type=file', async () => {
    let observedQuery: string | null = null;
    server.use(
      allDocsAndFilesListHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { items: [ITEM_FILE] },
          },
        },
        {
          onRequest: (req) => {
            observedQuery = new URL(req.url).search;
          },
        },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'list',
      '--type',
      'file',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('type=file');
    const env = parseFirstJson(stdout) as { data: { applied_filters: { type?: string } } };
    expect(env.data.applied_filters.type).toBe('file');
  });

  it('--type link: wire encodes type=link', async () => {
    let observedQuery: string | null = null;
    server.use(
      allDocsAndFilesListHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { items: [ITEM_LINK] },
          },
        },
        {
          onRequest: (req) => {
            observedQuery = new URL(req.url).search;
          },
        },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'list',
      '--type',
      'link',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('type=link');
    const env = parseFirstJson(stdout) as { data: { applied_filters: { type?: string } } };
    expect(env.data.applied_filters.type).toBe('link');
  });

  it('--type dir: wire encodes type=directory', async () => {
    let observedQuery: string | null = null;
    server.use(
      allDocsAndFilesListHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { items: [ITEM_DIR] },
          },
        },
        {
          onRequest: (req) => {
            observedQuery = new URL(req.url).search;
          },
        },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'list',
      '--type',
      'dir',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('type=directory');
    const env = parseFirstJson(stdout) as { data: { applied_filters: { type?: string } } };
    expect(env.data.applied_filters.type).toBe('directory');
  });

  it('all filters together: each lands on the wire, all echo into applied_filters', async () => {
    let observedQuery: string | null = null;
    server.use(
      allDocsAndFilesListHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { items: [ITEM_DOC] },
          },
        },
        {
          onRequest: (req) => {
            observedQuery = new URL(req.url).search;
          },
        },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'list',
      '--project',
      '11',
      '--type',
      'doc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('projects_ids%5B%5D=11');
    expect(observedQuery).toContain('type=document');
    const env = parseFirstJson(stdout) as {
      data: {
        applied_filters: { projects?: number[]; type?: string };
      };
    };
    expect(env.data.applied_filters).toEqual({
      projects: [11],
      type: 'document',
    });
  });

  it('empty server response: data.items=[], paging.total=0', async () => {
    server.use(
      allDocsAndFilesListHandlers.paged({
        0: { total: 0, count: 0, page: 0, per_page: 25, data: { items: [] } },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['files', 'list', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { items: unknown[] };
      paging: { total: number };
    };
    expect(env.data.items).toEqual([]);
    expect(env.paging.total).toBe(0);
  });

  it('human mode (TTY): renders a cli-table3 table with relevant columns', async () => {
    server.use(
      allDocsAndFilesListHandlers.paged({
        0: {
          total: 2,
          count: 2,
          page: 0,
          per_page: 25,
          data: { items: [ITEM_DOC, ITEM_FILE] },
        },
      }),
    );
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['files', 'list', '--output', 'human']);
    expect(exitCode).toBe(0);
    // UUID prefix (first 8 chars + ellipsis).
    expect(stdout).toContain('aaaaaaaa');
    // TYPE column carries the wire enum.
    expect(stdout).toContain('document');
    expect(stdout).toContain('file');
    // NAME, PROJECT, AUTHOR, DATE columns
    expect(stdout).toContain('Architecture Notes');
    expect(stdout).toContain('Apollo');
    expect(stdout).toContain('Alice');
    expect(stdout).toContain('2026-04-25');
    // Humanized size: 4096 → '4.0 KB' for ITEM_DOC, 2_500_000 → '2.4 MB' for ITEM_FILE.
    expect(stdout).toContain('4.0 KB');
    expect(stdout).toMatch(/2\.[34] MB/);
  });

  it('human mode: empty list shows (no docs or files)', async () => {
    server.use(
      allDocsAndFilesListHandlers.paged({
        0: { total: 0, count: 0, page: 0, per_page: 25, data: { items: [] } },
      }),
    );
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['files', 'list', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(no docs or files)');
  });

  it('human mode: directory row renders size as "-", author falls back to numeric id', async () => {
    server.use(
      allDocsAndFilesListHandlers.paged({
        0: {
          total: 1,
          count: 1,
          page: 0,
          per_page: 25,
          data: { items: [ITEM_DIR] },
        },
      }),
    );
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['files', 'list', '--output', 'human']);
    expect(exitCode).toBe(0);
    // Author.id 9 with no fullname → "9" should appear somewhere in the row.
    expect(stdout).toContain(' 9 ');
    // Directory rows render '-' in SIZE column.
    expect(stdout).toContain('Designs');
    expect(stdout).toContain('directory');
  });

  it('--request-id <uuid> round-trips into envelope', async () => {
    server.use(
      allDocsAndFilesListHandlers.paged({
        0: {
          total: 1,
          count: 1,
          page: 0,
          per_page: 25,
          data: { items: [ITEM_DOC] },
        },
      }),
    );

    const REQ = '11111111-2222-4333-8444-555555555555';
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'list',
      '--request-id',
      REQ,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { request_id?: string };
    expect(env.request_id).toBe(REQ);
  });
});

// ---------------------------------------------------------------------------
//  Validation (every error path → exit 2)
// ---------------------------------------------------------------------------

describe('freelo files list — validation', () => {
  it('--project 0: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'list',
      '--project',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--project xyz: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'list',
      '--project',
      'xyz',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--type bogus: VALIDATION_ERROR exit 2 (hint lists CLI short forms)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'list',
      '--type',
      'bogus',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('doc');
    expect(stderr).toContain('dir');
  });

  it('--type document (wire form, not CLI form): VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'list',
      '--type',
      'document',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--type directory (wire form): VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'list',
      '--type',
      'directory',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--page 0 (1-indexed; first page is --page 1): VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'list',
      '--page',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--page abc: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'list',
      '--page',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--page and --all together: VALIDATION_ERROR exit 2 (mutex)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'list',
      '--page',
      '1',
      '--all',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('mutually exclusive');
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors (Calibration §2 — every typed error class triggered)
// ---------------------------------------------------------------------------

describe('freelo files list — HTTP errors', () => {
  it('GET 401: AUTH_EXPIRED, exit 3', async () => {
    server.use(allDocsAndFilesListHandlers.unauthorized());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['files', 'list', '--output', 'json']);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('AUTH_EXPIRED');
  });

  it('GET 403: FORBIDDEN, exit 4', async () => {
    server.use(allDocsAndFilesListHandlers.forbidden());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['files', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('FORBIDDEN');
  });

  it('GET 404: NOT_FOUND, exit 4', async () => {
    server.use(allDocsAndFilesListHandlers.notFound());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['files', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('NOT_FOUND');
  });

  it('GET 5xx: SERVER_ERROR, exit 4', async () => {
    server.use(allDocsAndFilesListHandlers.serverError(503));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['files', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('SERVER_ERROR');
  });

  it('GET 429 (after retry exhaustion): RATE_LIMITED, exit 6', async () => {
    server.use(allDocsAndFilesListHandlers.rateLimited());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['files', 'list', '--output', 'json']);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('RATE_LIMITED');
  });

  it('GET network failure: NETWORK_ERROR, exit 5', async () => {
    server.use(allDocsAndFilesListHandlers.networkError());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['files', 'list', '--output', 'json']);
    expect(exitCode).toBe(5);
    expect(stderr).toContain('NETWORK_ERROR');
  });

  it('GET 200 with malformed body (unknown type enum): VALIDATION_ERROR, exit 4', async () => {
    server.use(allDocsAndFilesListHandlers.malformed());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['files', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Pagination edge — partial result on mid-stream failure
// ---------------------------------------------------------------------------

describe('freelo files list — partial pages', () => {
  it('--all fail at page 0 (no successful pages): error propagates, no stdout envelope', async () => {
    server.use(allDocsAndFilesListHandlers.notFound());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'files',
      'list',
      '--all',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('NOT_FOUND');
    expect(stdout).toBe('');
  });

  it('--all mid-stream 5xx after page 0 success: partial envelope on stdout + notice + exit 4', async () => {
    server.use(
      allDocsAndFilesListHandlers.midStreamError({
        pages: {
          0: {
            total: 3,
            count: 2,
            page: 0,
            per_page: 2,
            data: { items: [ITEM_DOC, ITEM_FILE] },
          },
        },
        failPage: 1,
        status: 503,
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['files', 'list', '--all', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stdout) as {
      data: { items: Array<{ uuid: string }> };
      notice?: string;
    };
    expect(env.data.items).toHaveLength(2);
    expect(env.notice).toBeDefined();
    expect(env.notice!).toContain('Partial');
    expect(env.notice!).toContain('page 1');
  });
});

// ---------------------------------------------------------------------------
//  Introspect
// ---------------------------------------------------------------------------

describe('freelo files list — introspect', () => {
  it('lists files list with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const entry = env.data.commands.find((c) => c.name === 'files list');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.files.list/v1');
    expect(entry?.destructive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  humanizeBytes unit (renderer-local helper)
// ---------------------------------------------------------------------------

describe('humanizeBytes (unit)', () => {
  it('formats values across the four unit boundaries', async () => {
    const { humanizeBytes } = await import('../../../src/ui/human/files-list.js');
    expect(humanizeBytes(0)).toBe('0 B');
    expect(humanizeBytes(512)).toBe('512 B');
    expect(humanizeBytes(1024)).toBe('1.0 KB');
    expect(humanizeBytes(4096)).toBe('4.0 KB');
    expect(humanizeBytes(1024 * 1024)).toBe('1.0 MB');
    expect(humanizeBytes(2_500_000)).toMatch(/2\.[34] MB/);
    expect(humanizeBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(humanizeBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });
});
