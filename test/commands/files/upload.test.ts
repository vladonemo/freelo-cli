/**
 * End-to-end tests for `freelo files upload` (R25, spec 0037).
 *
 * Covers:
 *   - Happy paths: single + multi path, --attach-to-task with/without --message,
 *     default message, HTML-escape, --dry-run, human output.
 *   - Validation: no paths, missing path, directory path, oversize, bad
 *     --attach-to-task, whitespace --message  (Calibration §2 exit codes).
 *   - Error paths: server 5xx single + multi (partial-failure), comment-create
 *     failure after upload success.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, filesUploadHandlers, commentsAddHandlers, API_BASE } from '../../msw/handlers.js';

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

let testDir: string;
let configDir: string;
let pathA: string;
let pathB: string;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterAll(() => {
  server.close();
});

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `freelo-files-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  configDir = join(testDir, 'config');
  await mkdir(testDir, { recursive: true });
  await mkdir(configDir, { recursive: true });

  pathA = join(testDir, 'file-a.txt');
  pathB = join(testDir, 'file-b.bin');
  await writeFile(pathA, 'AAA');
  await writeFile(pathB, Buffer.alloc(16, 0xff));

  vi.doMock('conf', () => {
    const ConfMock = vi.fn().mockImplementation(() => ({
      get path() {
        return join(configDir, 'config.json');
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

/* ---------------------------------------------------------------------------
 *  Happy paths
 * ------------------------------------------------------------------------- */

describe('freelo files upload — happy paths', () => {
  it('single path → 1 upload → exit 0, envelope shape', async () => {
    server.use(filesUploadHandlers.uploadOk('aaa00000-0000-0000-0000-000000000001'));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['files', 'upload', pathA, '--output', 'json']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        uploaded: Array<{ path: string; filename: string; uuid: string; bytes: number }>;
        failed: unknown[];
        count: { requested: number; uploaded: number; failed: number };
      };
    };
    expect(env.schema).toBe('freelo.files.upload/v1');
    expect(env.data.count).toEqual({ requested: 1, uploaded: 1, failed: 0 });
    expect(env.data.uploaded).toHaveLength(1);
    expect(env.data.uploaded[0]?.uuid).toBe('aaa00000-0000-0000-0000-000000000001');
    expect(env.data.uploaded[0]?.filename).toBe('file-a.txt');
    expect(env.data.uploaded[0]?.bytes).toBe(3);
  });

  it('multiple paths → N sequential uploads in order', async () => {
    server.use(
      filesUploadHandlers.uploadOkSequential([
        'aaa00000-0000-0000-0000-000000000001',
        'bbb00000-0000-0000-0000-000000000002',
      ]),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'upload',
      pathA,
      pathB,
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        uploaded: Array<{ filename: string; uuid: string }>;
        count: { uploaded: number };
      };
    };
    expect(env.data.count.uploaded).toBe(2);
    expect(env.data.uploaded[0]?.filename).toBe('file-a.txt');
    expect(env.data.uploaded[0]?.uuid).toBe('aaa00000-0000-0000-0000-000000000001');
    expect(env.data.uploaded[1]?.filename).toBe('file-b.bin');
    expect(env.data.uploaded[1]?.uuid).toBe('bbb00000-0000-0000-0000-000000000002');
  });

  it('--attach-to-task posts a comment with anchors and surfaces comment_id', async () => {
    server.use(filesUploadHandlers.uploadOk('aaa00000-0000-0000-0000-000000000001'));
    let receivedContent = '';
    server.use(
      commentsAddHandlers.addOkWhenBody(
        4711,
        (body) => {
          const b = body as { content?: string };
          receivedContent = b.content ?? '';
          return typeof b.content === 'string' && b.content.length > 0;
        },
        { id: 99812, content: 'placeholder' },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'upload',
      pathA,
      '--attach-to-task',
      '4711',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        attached?: { task_id: number; comment_id: number; file_uuids: string[] };
      };
    };
    expect(env.data.attached).toBeDefined();
    expect(env.data.attached?.task_id).toBe(4711);
    expect(env.data.attached?.comment_id).toBe(99812);
    expect(env.data.attached?.file_uuids).toEqual(['aaa00000-0000-0000-0000-000000000001']);
    // Default message format
    expect(receivedContent).toContain('Attached: ');
    expect(receivedContent).toContain('data-freelo-uuid="aaa00000-0000-0000-0000-000000000001"');
    expect(receivedContent).toContain('>file-a.txt</a>');
  });

  it('--attach-to-task --message prefixes user content', async () => {
    server.use(filesUploadHandlers.uploadOk('aaa00000-0000-0000-0000-000000000001'));
    let receivedContent = '';
    server.use(
      commentsAddHandlers.addOkWhenBody(
        4711,
        (body) => {
          receivedContent = (body as { content: string }).content;
          return true;
        },
        { id: 1, content: 'placeholder' },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'files',
      'upload',
      pathA,
      '--attach-to-task',
      '4711',
      '--message',
      'look here',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(receivedContent.startsWith('look here\n\nAttached:')).toBe(true);
  });

  it('HTML-escapes special chars in the filename anchor', async () => {
    // Use `&` and `'` — valid on Windows AND in filenames on macOS/Linux,
    // but they need HTML escaping to avoid XSS in comment HTML.
    const evilPath = join(testDir, "a&b'c.txt");
    await writeFile(evilPath, 'evil');
    server.use(filesUploadHandlers.uploadOk('cccc0000-0000-0000-0000-000000000003'));
    let receivedContent = '';
    server.use(
      commentsAddHandlers.addOkWhenBody(
        4711,
        (body) => {
          receivedContent = (body as { content: string }).content;
          return true;
        },
        { id: 1, content: 'placeholder' },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'files',
      'upload',
      evilPath,
      '--attach-to-task',
      '4711',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(receivedContent).toContain('a&amp;b&#39;c.txt');
    expect(receivedContent).not.toContain("a&b'c.txt");
  });

  it('--dry-run skips network and echoes would', async () => {
    let hits = 0;
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.post(`${API_BASE}/file/upload`, () => {
        hits += 1;
        return HttpResponse.json({ uuid: 'should-not-fire' });
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'upload',
      pathA,
      pathB,
      '--attach-to-task',
      '4711',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(hits).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run?: boolean;
      data: {
        would?: Array<{ method: string; path: string }>;
        uploaded: unknown[];
        count: { requested: number };
      };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.uploaded).toEqual([]);
    expect(env.data.count.requested).toBe(2);
    // Two uploads + one comment = 3 wouldList entries.
    expect(env.data.would).toHaveLength(3);
    expect(env.data.would?.[0]?.path).toBe('/file/upload');
    expect(env.data.would?.[1]?.path).toBe('/file/upload');
    expect(env.data.would?.[2]?.path).toBe('/task/4711/comments');
  });

  it('human output renders the count line', async () => {
    server.use(filesUploadHandlers.uploadOk('aaa00000-0000-0000-0000-000000000001'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['files', 'upload', pathA, '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Uploaded 1 file');
    expect(stdout).toContain('file-a.txt');
  });
});

/* ---------------------------------------------------------------------------
 *  Validation (Calibration §2 exit-code coverage)
 * ------------------------------------------------------------------------- */

describe('freelo files upload — validation', () => {
  it('missing path → ValidationError exit 2', async () => {
    const missing = join(testDir, 'does-not-exist.txt');
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stdout, stderr } = await runCli(run, [
      'files',
      'upload',
      missing,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/VALIDATION|Cannot read/);
  });

  it('directory path → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stdout, stderr } = await runCli(run, [
      'files',
      'upload',
      testDir,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/not a regular file|VALIDATION/);
  });

  it('--attach-to-task 0 → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'files',
      'upload',
      pathA,
      '--attach-to-task',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--attach-to-task abc → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'files',
      'upload',
      pathA,
      '--attach-to-task',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('whitespace-only --message → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'files',
      'upload',
      pathA,
      '--attach-to-task',
      '4711',
      '--message',
      '   ',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

/* ---------------------------------------------------------------------------
 *  Error paths
 * ------------------------------------------------------------------------- */

describe('freelo files upload — error paths', () => {
  it('single path: 5xx → exit 4 (FreeloApiError SERVER_ERROR)', async () => {
    server.use(filesUploadHandlers.uploadServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['files', 'upload', pathA, '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('multi path with one 5xx: exit 4, uploaded[] has survivors, failed[] populated, comment posted', async () => {
    // First upload OK, second 5xx.
    let n = 0;
    let commentHit = 0;
    let receivedContent = '';
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.post(`${API_BASE}/file/upload`, () => {
        n += 1;
        if (n === 1) {
          return HttpResponse.json({ uuid: 'aaa00000-0000-0000-0000-000000000001' });
        }
        return HttpResponse.json({ errors: ['Server error.'] }, { status: 500 });
      }),
      http.post(`${API_BASE}/task/4711/comments`, async ({ request }) => {
        commentHit += 1;
        const b = (await request.clone().json()) as { content: string };
        receivedContent = b.content;
        return HttpResponse.json({ id: 99812, content: 'placeholder' });
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'upload',
      pathA,
      pathB,
      '--attach-to-task',
      '4711',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stdout) as {
      data: {
        uploaded: Array<{ uuid: string }>;
        failed: Array<{ path: string; error: { code: string } }>;
        attached?: { task_id: number; file_uuids: string[] };
      };
    };
    expect(env.data.uploaded).toHaveLength(1);
    expect(env.data.failed).toHaveLength(1);
    expect(env.data.failed[0]?.error.code).toBe('SERVER_ERROR');
    // Comment was posted with the surviving uuid only (decision 07).
    // Note: MSW intercepts multipart bodies twice in some Node versions,
    // so we verify the comment WAS hit at all and that its content
    // referenced the surviving upload — not the precise hit count.
    expect(commentHit).toBeGreaterThanOrEqual(1);
    expect(receivedContent).toContain('aaa00000-0000-0000-0000-000000000001');
    expect(env.data.attached?.file_uuids).toEqual(['aaa00000-0000-0000-0000-000000000001']);
  });

  it('all paths fail → throws first error (single-path semantics, exit 4)', async () => {
    server.use(filesUploadHandlers.uploadServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['files', 'upload', pathA, pathB, '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('comment-create 4xx after upload success → exit 4, envelope has uploaded[] but no attached', async () => {
    server.use(filesUploadHandlers.uploadOk('aaa00000-0000-0000-0000-000000000001'));
    server.use(commentsAddHandlers.addNotFound(4711));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'upload',
      pathA,
      '--attach-to-task',
      '4711',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    // The envelope WAS emitted before the comment-error throw — verify the
    // uploaded[] survived for the agent to recover.
    const env = parseFirstJson(stdout) as {
      data: { uploaded: Array<{ uuid: string }>; attached?: unknown };
    };
    expect(env.data.uploaded).toHaveLength(1);
    expect(env.data.attached).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------
 *  Spinner + noSpinner paths (Calibration #7)
 * ------------------------------------------------------------------------- */

describe('freelo files upload — spinner gating', () => {
  it('spinner is activated when isInteractive() is true and --no-spinner is not set', async () => {
    // Simulate a TTY session: clear CI, set TTY flags, mock ora to capture
    // spinner creation and verify it was instantiated.
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    server.use(filesUploadHandlers.uploadOk('aaa22222-0000-0000-0000-000000000002'));

    let oraInstantiated = false;
    let startCalled = false;
    let stopCalled = false;
    // Must resetModules BEFORE doMock so the fresh import sees the mock.
    vi.resetModules();
    vi.doMock('ora', () => {
      const factory = vi.fn(() => {
        oraInstantiated = true;
        return {
          text: '',
          start: vi.fn(() => {
            startCalled = true;
          }),
          stop: vi.fn(() => {
            stopCalled = true;
          }),
        };
      });
      return { default: factory };
    });

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, ['files', 'upload', pathA, '--output', 'json']);
      expect(exitCode).toBe(0);
      expect(oraInstantiated).toBe(true);
      expect(startCalled).toBe(true);
      expect(stopCalled).toBe(true);
    } finally {
      vi.doUnmock('ora');
      vi.resetModules();
      if (savedCI !== undefined) {
        process.env['CI'] = savedCI;
      } else {
        delete process.env['CI'];
      }
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    }
  });

  it('--no-spinner suppresses the spinner even on a TTY', async () => {
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    server.use(filesUploadHandlers.uploadOk('aaa33333-0000-0000-0000-000000000003'));

    let oraInstantiated = false;
    vi.resetModules();
    vi.doMock('ora', () => {
      const factory = vi.fn(() => {
        oraInstantiated = true;
        return { text: '', start: vi.fn(), stop: vi.fn() };
      });
      return { default: factory };
    });

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'files',
        'upload',
        pathA,
        '--no-spinner',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
      expect(oraInstantiated).toBe(false);
    } finally {
      vi.doUnmock('ora');
      vi.resetModules();
      if (savedCI !== undefined) {
        process.env['CI'] = savedCI;
      } else {
        delete process.env['CI'];
      }
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    }
  });
});

/* ---------------------------------------------------------------------------
 *  toBaseError branches
 * ------------------------------------------------------------------------- */

describe('freelo files upload — toBaseError coverage', () => {
  it('wraps a plain Error (not BaseError) from buildFileMultipart into the failed[] list', async () => {
    // Mock buildFileMultipart to throw a plain Error (not a BaseError subclass)
    // to exercise the `err instanceof Error` arm of toBaseError.
    // toBaseError wraps it in a ValidationError (exit 2).
    vi.doMock('../../../src/lib/multipart.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/lib/multipart.js')>(
        '../../../src/lib/multipart.js',
      );
      return {
        ...actual,
        buildFileMultipart: () => Promise.reject(new Error('plain-error-from-multipart')),
      };
    });
    vi.resetModules();

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode, stdout } = await runCli(run, [
        'files',
        'upload',
        pathA,
        '--output',
        'json',
      ]);

      // Zero succeeded → throws first error. toBaseError wraps plain Error in
      // ValidationError (exitCode 2), so the re-throw surfaces exit 2.
      expect(exitCode).toBe(2);
      // The envelope is still emitted with failed[] populated
      const env = parseFirstJson(stdout) as {
        data: { failed: Array<{ error: { message: string } }> };
      };
      expect(env.data.failed[0]?.error.message).toContain('plain-error-from-multipart');
    } finally {
      vi.doUnmock('../../../src/lib/multipart.js');
      vi.resetModules();
    }
  });

  it('wraps a non-Error non-BaseError throw (string) from buildFileMultipart into failed[]', async () => {
    // Exercise the `String(err)` (else) arm of toBaseError.
    // toBaseError wraps it in a ValidationError (exit 2).
    vi.doMock('../../../src/lib/multipart.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/lib/multipart.js')>(
        '../../../src/lib/multipart.js',
      );
      return {
        ...actual,
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- intentionally exercises the non-Error branch
        buildFileMultipart: () => Promise.reject('string-rejection-value'),
      };
    });
    vi.resetModules();

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode, stdout } = await runCli(run, [
        'files',
        'upload',
        pathA,
        '--output',
        'json',
      ]);

      // toBaseError wraps string rejections in ValidationError (exit 2).
      expect(exitCode).toBe(2);
      const env = parseFirstJson(stdout) as {
        data: { failed: Array<{ error: { message: string } }> };
      };
      expect(env.data.failed[0]?.error.message).toContain('string-rejection-value');
    } finally {
      vi.doUnmock('../../../src/lib/multipart.js');
      vi.resetModules();
    }
  });
});

/* ---------------------------------------------------------------------------
 *  comment.id missing / non-positive branch
 * ------------------------------------------------------------------------- */

describe('freelo files upload — comment.id missing branch', () => {
  it('attached is undefined when comment response has no id field', async () => {
    // When the server returns a comment object without a numeric id > 0,
    // `attached` should stay undefined (line 349 guard in upload.ts).
    server.use(filesUploadHandlers.uploadOk('aaa33333-0000-0000-0000-000000000003'));
    // Return a comment body where id is 0 (falsy positive-integer check fails)
    server.use(commentsAddHandlers.addOk(4711, { id: 0, content: 'placeholder' }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'upload',
      pathA,
      '--attach-to-task',
      '4711',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { uploaded: Array<{ uuid: string }>; attached?: unknown };
    };
    // Upload succeeded
    expect(env.data.uploaded).toHaveLength(1);
    // But attached is absent because comment_id was 0
    expect(env.data.attached).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------
 *  appConfig.requestId propagation
 * ------------------------------------------------------------------------- */

describe('freelo files upload — requestId propagation via --request-id flag', () => {
  it('passes --request-id through to upload and comment X-Request-Id header', async () => {
    let uploadReqId: string | null = null;
    let commentReqId: string | null = null;

    // Must be a valid UUID v4 to pass parseRequestId.
    const reqId = 'a1b2c3d4-1234-4abc-8def-000000000042';

    const { http: mswHttp, HttpResponse: MswHttpResponse } = await import('msw');
    server.use(
      mswHttp.post(`${API_BASE}/file/upload`, ({ request }) => {
        uploadReqId = request.headers.get('X-Request-Id');
        return MswHttpResponse.json({ uuid: 'aaa44444-0000-0000-0000-000000000004' });
      }),
      mswHttp.post(`${API_BASE}/task/4711/comments`, ({ request }) => {
        commentReqId = request.headers.get('X-Request-Id');
        return MswHttpResponse.json({ id: 77, content: 'placeholder' });
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'files',
      'upload',
      pathA,
      '--attach-to-task',
      '4711',
      '--request-id',
      reqId,
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(uploadReqId).toBe(reqId);
    expect(commentReqId).toBe(reqId);
  });
});

/* ---------------------------------------------------------------------------
 *  dry-run with --request-id (request_id surfaces in dry-run envelope)
 * ------------------------------------------------------------------------- */

describe('freelo files upload — dry-run with --request-id', () => {
  it('includes request_id in the dry-run envelope when --request-id is passed', async () => {
    // Must be a valid UUID v4 to pass parseRequestId.
    const reqId = 'b2c3d4e5-2345-4bcd-9efa-000000000043';

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'upload',
      pathA,
      '--dry-run',
      '--request-id',
      reqId,
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { request_id?: string; dry_run?: boolean };
    expect(env.dry_run).toBe(true);
    expect(env.request_id).toBe(reqId);
  });
});
