/**
 * End-to-end tests for `freelo files download` (R27, spec 0039).
 *
 * Covers:
 *   - Happy paths: default destination (Content-Disposition + UUID fallback),
 *     -o relative + absolute, -o pointing to existing dir, --stdout, empty
 *     body, force-overwrite, RFC 5987 filename*.
 *   - Validation: malformed UUID, -o + --stdout, --force + --stdout,
 *     destination exists w/o --force, parent dir missing
 *     (Calibration §2 exit codes).
 *   - Error paths: 404, 5xx, 429, network drop mid-stream (with temp-file
 *     cleanup verification).
 *   - Path-traversal defense for malicious Content-Disposition.
 */

import { join, dirname, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server, filesDownloadHandlers } from '../../msw/handlers.js';

const TEST_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function captureOutput() {
  const stdout: Array<string | Uint8Array> = [];
  const stderr: string[] = [];
  let firstExitCode: number | undefined;
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    if (typeof chunk === 'string') {
      stdout.push(chunk);
    } else if (chunk instanceof Uint8Array) {
      stdout.push(chunk);
    } else {
      stdout.push(String(chunk));
    }
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
    stdoutChunks: stdout,
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
): Promise<{
  stdoutText: string;
  stdoutBytes: Buffer;
  stderr: string;
  exitCode: number;
}> {
  const { stdoutChunks, stderr, getFirstExitCode, restore } = captureOutput();
  try {
    await runFn(['node', 'freelo', ...args]);
  } catch {
    /* swallow */
  } finally {
    restore();
  }
  // Reconstruct stdout: concatenate Buffers (binary), join strings as text.
  const buffers: Buffer[] = [];
  let textOnly = '';
  for (const c of stdoutChunks) {
    if (typeof c === 'string') {
      textOnly += c;
      buffers.push(Buffer.from(c));
    } else {
      buffers.push(Buffer.from(c));
    }
  }
  return {
    stdoutText: textOnly,
    stdoutBytes: Buffer.concat(buffers),
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
let originalCwd: string;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterAll(() => {
  server.close();
});

beforeEach(async () => {
  const raw = join(
    tmpdir(),
    `freelo-files-download-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(raw, { recursive: true });
  // Canonicalize so that on macOS (where /var → /private/var) the test's
  // expected paths match what process.cwd() returns after chdir.
  testDir = realpathSync(raw);
  configDir = join(testDir, 'config');
  await mkdir(configDir, { recursive: true });

  originalCwd = process.cwd();
  process.chdir(testDir);

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
  process.chdir(originalCwd);
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/* ---------------------------------------------------------------------------
 *  Happy paths
 * ------------------------------------------------------------------------- */

describe('freelo files download — happy paths', () => {
  it('default destination uses Content-Disposition filename in CWD', async () => {
    const fixture = Buffer.from('Hello Freelo');
    server.use(
      filesDownloadHandlers.downloadOk({
        bytes: fixture,
        contentType: 'text/plain',
        contentDisposition: 'attachment; filename="report.txt"',
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdoutText, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);

    const env = parseFirstJson(stdoutText) as {
      schema: string;
      data: {
        uuid: string;
        destination: string;
        bytes: number;
        filename: string | null;
        content_type: string | null;
        overwrote: boolean;
      };
    };
    expect(env.schema).toBe('freelo.files.download/v1');
    expect(env.data.uuid).toBe(TEST_UUID);
    expect(env.data.bytes).toBe(fixture.length);
    expect(env.data.filename).toBe('report.txt');
    expect(env.data.content_type).toBe('text/plain');
    expect(env.data.overwrote).toBe(false);
    expect(isAbsolute(env.data.destination)).toBe(true);
    expect(env.data.destination.endsWith('report.txt')).toBe(true);

    // The file actually exists with the right bytes.
    const onDisk = await readFile(env.data.destination);
    expect(Buffer.compare(onDisk, fixture)).toBe(0);
  });

  it('default destination uses <uuid>.bin when Content-Disposition is absent', async () => {
    server.use(
      filesDownloadHandlers.downloadOk({
        bytes: Buffer.from([1, 2, 3]),
        contentType: 'application/octet-stream',
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdoutText, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdoutText) as { data: { destination: string; filename: null } };
    expect(env.data.destination.endsWith(`${TEST_UUID}.bin`)).toBe(true);
    expect(env.data.filename).toBeNull();
  });

  it('-o <relpath> writes to a relative path; envelope.destination is absolute', async () => {
    const fixture = Buffer.from('relative');
    server.use(filesDownloadHandlers.downloadOk({ bytes: fixture, contentType: 'text/plain' }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdoutText, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '-o',
      './out.bin',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdoutText) as { data: { destination: string; bytes: number } };
    expect(isAbsolute(env.data.destination)).toBe(true);
    expect(env.data.destination.endsWith('out.bin')).toBe(true);
    const onDisk = await readFile(env.data.destination);
    expect(Buffer.compare(onDisk, fixture)).toBe(0);
  });

  it('-o <abspath> writes to an absolute path', async () => {
    const fixture = Buffer.from('absolute');
    const dest = join(testDir, 'sub', 'file.bin');
    await mkdir(dirname(dest), { recursive: true });
    server.use(filesDownloadHandlers.downloadOk({ bytes: fixture, contentType: 'text/plain' }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdoutText, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '-o',
      dest,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdoutText) as { data: { destination: string } };
    expect(env.data.destination).toBe(dest);
    const onDisk = await readFile(dest);
    expect(Buffer.compare(onDisk, fixture)).toBe(0);
  });

  it('-o <existing-dir> resolves to <dir>/<inferred> (decision 10)', async () => {
    const dir = join(testDir, 'downloads');
    await mkdir(dir, { recursive: true });
    server.use(
      filesDownloadHandlers.downloadOk({
        bytes: Buffer.from('inside-dir'),
        contentType: 'text/plain',
        contentDisposition: 'attachment; filename="report.txt"',
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdoutText, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '-o',
      dir,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdoutText) as { data: { destination: string } };
    expect(env.data.destination).toBe(join(dir, 'report.txt'));
    const onDisk = await readFile(env.data.destination);
    expect(onDisk.toString()).toBe('inside-dir');
  });

  it('--stdout pipes binary to stdout; envelope JSON to stderr', async () => {
    const fixture = Buffer.from([0x00, 0x01, 0xff, 0x42]);
    server.use(
      filesDownloadHandlers.downloadOk({
        bytes: fixture,
        contentType: 'application/octet-stream',
        contentDisposition: 'attachment; filename="any.bin"',
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdoutBytes, stderr, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '--stdout',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(Buffer.compare(stdoutBytes, fixture)).toBe(0);

    const env = parseFirstJson(stderr) as {
      schema: string;
      data: { destination: string; bytes: number; filename: string | null };
    };
    expect(env.schema).toBe('freelo.files.download/v1');
    expect(env.data.destination).toBe('stdout');
    expect(env.data.bytes).toBe(fixture.length);
    expect(env.data.filename).toBe('any.bin');
  });

  it('--stdout in human mode is silent on stderr (no summary chatter)', async () => {
    const fixture = Buffer.from('xyz');
    server.use(filesDownloadHandlers.downloadOk({ bytes: fixture, contentType: 'text/plain' }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdoutBytes, stderr, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '--stdout',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(Buffer.compare(stdoutBytes, fixture)).toBe(0);
    expect(stderr).toBe('');
  });

  it('parses RFC 5987 filename* (UTF-8 percent-decoded)', async () => {
    server.use(
      filesDownloadHandlers.downloadOk({
        bytes: Buffer.from('utf8'),
        contentType: 'text/plain',
        contentDisposition: "attachment; filename*=UTF-8''na%C3%AFve.txt",
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdoutText, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdoutText) as {
      data: { filename: string | null; destination: string };
    };
    expect(env.data.filename).toBe('naïve.txt');
    expect(env.data.destination.endsWith('naïve.txt')).toBe(true);
  });

  it('empty body (0 bytes) creates a 0-byte file and exits 0', async () => {
    server.use(filesDownloadHandlers.downloadEmpty());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdoutText, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdoutText) as { data: { bytes: number; destination: string } };
    expect(env.data.bytes).toBe(0);
    const stats = await stat(env.data.destination);
    expect(stats.size).toBe(0);
  });

  it('--force overwrites an existing destination', async () => {
    const dest = join(testDir, 'existing.txt');
    await writeFile(dest, 'OLD CONTENT');

    const fixture = Buffer.from('NEW BYTES');
    server.use(filesDownloadHandlers.downloadOk({ bytes: fixture, contentType: 'text/plain' }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdoutText, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '-o',
      dest,
      '--force',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdoutText) as { data: { overwrote: boolean } };
    expect(env.data.overwrote).toBe(true);
    const onDisk = await readFile(dest);
    expect(Buffer.compare(onDisk, fixture)).toBe(0);
  });

  it('path-traversal defense: malicious Content-Disposition cannot escape CWD', async () => {
    server.use(
      filesDownloadHandlers.downloadOk({
        bytes: Buffer.from('attack'),
        contentType: 'text/plain',
        contentDisposition: 'attachment; filename="../../../etc/passwd"',
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdoutText, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdoutText) as {
      data: { destination: string; filename: string | null };
    };
    // filename in envelope is the RAW server value (for trace correlation).
    expect(env.data.filename).toBe('../../../etc/passwd');
    // destination must resolve INSIDE testDir (== CWD here), not outside.
    // The sanitized basename is `passwd`.
    expect(env.data.destination).toBe(join(testDir, 'passwd'));
    // Verify nothing escaped CWD.
    expect(env.data.destination.startsWith(testDir)).toBe(true);
  });

  it('falls back to <uuid>.bin when Content-Disposition has no recognizable filename', async () => {
    // Disposition exists but no filename param.
    server.use(
      filesDownloadHandlers.downloadOk({
        bytes: Buffer.from('fallback'),
        contentType: 'text/plain',
        contentDisposition: 'attachment',
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdoutText, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdoutText) as { data: { destination: string } };
    expect(env.data.destination.endsWith(`${TEST_UUID}.bin`)).toBe(true);
  });

  it('human-mode renders the one-line summary on stdout', async () => {
    const fixture = Buffer.from('humanout');
    server.use(
      filesDownloadHandlers.downloadOk({
        bytes: fixture,
        contentType: 'text/plain',
        contentDisposition: 'attachment; filename="hi.txt"',
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdoutText, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdoutText).toMatch(/Downloaded\s+hi\.txt/);
    expect(stdoutText).toMatch(/→/);
  });
});

/* ---------------------------------------------------------------------------
 *  Validation paths (Calibration §2 exit-code coverage)
 * ------------------------------------------------------------------------- */

describe('freelo files download — validation', () => {
  it('malformed UUID → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'download',
      'not-a-uuid',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('-o + --stdout → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '-o',
      './x',
      '--stdout',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--force + --stdout → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '--stdout',
      '--force',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('destination exists, no --force → ValidationError exit 2', async () => {
    const dest = join(testDir, 'protected.txt');
    await writeFile(dest, 'do not clobber');

    server.use(
      filesDownloadHandlers.downloadOk({ bytes: Buffer.from('NEW'), contentType: 'text/plain' }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '-o',
      dest,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/already exists/);

    // Original content unchanged.
    const onDisk = await readFile(dest, 'utf8');
    expect(onDisk).toBe('do not clobber');
  });

  it('-o parent dir does not exist → ValidationError exit 2', async () => {
    server.use(
      filesDownloadHandlers.downloadOk({ bytes: Buffer.from('x'), contentType: 'text/plain' }),
    );

    const dest = join(testDir, 'nope', 'still-nope', 'file.bin');
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '-o',
      dest,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });
});

/* ---------------------------------------------------------------------------
 *  Error paths (HTTP)
 * ------------------------------------------------------------------------- */

describe('freelo files download — HTTP error paths', () => {
  it('404 → FreeloApiError exit 4; no file written', async () => {
    server.use(filesDownloadHandlers.notFound());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string; http_status: number | null } };
    expect(env.error.http_status).toBe(404);

    const after = await readdir(testDir);
    // No new files in CWD beyond the config dir.
    expect(after.filter((n) => n.endsWith('.bin') || n.endsWith('.tmp'))).toEqual([]);
  });

  it('5xx → FreeloApiError exit 4', async () => {
    server.use(filesDownloadHandlers.serverError(503));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { http_status: number | null } };
    expect(env.error.http_status).toBe(503);
  });

  it('429 → RateLimitedError exit 6 (no retry per decision 05)', async () => {
    server.use(filesDownloadHandlers.rateLimited());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('RATE_LIMITED');
  });

  it('mid-stream failure → NetworkError exit 5; temp file removed', async () => {
    server.use(
      filesDownloadHandlers.midStreamError({
        firstChunk: new Uint8Array([1, 2, 3, 4]),
        declaredLength: 1024,
      }),
    );

    const dest = join(testDir, 'partial.bin');
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '-o',
      dest,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(5);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('NETWORK_ERROR');

    // Verify NO `.tmp` files remain in the destination dir, and the
    // destination itself was never created.
    const dirContents = await readdir(testDir);
    expect(dirContents.filter((n) => n.includes('.tmp'))).toEqual([]);
    expect(dirContents).not.toContain('partial.bin');
  });

  it('network-level error (no response at all) → NetworkError exit 5', async () => {
    server.use(filesDownloadHandlers.networkError());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(5);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('NETWORK_ERROR');
  });
});

/* ---------------------------------------------------------------------------
 *  Introspection
 * ------------------------------------------------------------------------- */

describe('freelo files download — introspection', () => {
  it('declares output_schema and non-destructive in --introspect', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdoutText, exitCode } = await runCli(run, ['--introspect', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdoutText) as {
      data: {
        commands: Array<{
          name: string;
          output_schema?: string | null;
          destructive?: boolean;
        }>;
      };
    };
    const dl = env.data.commands.find((c) => c.name === 'files download');
    expect(dl).toBeDefined();
    expect(dl?.output_schema).toBe('freelo.files.download/v1');
    expect(dl?.destructive).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 *  renderFilesDownloadHuman — unit tests (branch coverage for null filename)
 * ------------------------------------------------------------------------- */

describe('renderFilesDownloadHuman', () => {
  it('omits filename when null (UUID-fallback path)', async () => {
    const { renderFilesDownloadHuman } = await import('../../../src/ui/human/files-download.js');
    const out = renderFilesDownloadHuman({
      uuid: 'abc',
      destination: '/tmp/abc.bin',
      bytes: 1024,
      filename: null,
      content_type: null,
      overwrote: false,
    });
    expect(out).toBe('Downloaded 1.0 KB → /tmp/abc.bin');
  });

  it('includes filename when present', async () => {
    const { renderFilesDownloadHuman } = await import('../../../src/ui/human/files-download.js');
    const out = renderFilesDownloadHuman({
      uuid: 'abc',
      destination: '/tmp/foo.txt',
      bytes: 1024,
      filename: 'foo.txt',
      content_type: null,
      overwrote: false,
    });
    expect(out).toBe('Downloaded foo.txt (1.0 KB) → /tmp/foo.txt');
  });
});

/* ---------------------------------------------------------------------------
 *  pumpToStdout error branches — EPIPE treated as success, other errors
 *  wrapped in NetworkError.
 * ------------------------------------------------------------------------- */

describe('freelo files download — pumpToStdout error branches', () => {
  it('EPIPE from body stream is treated as success (exit 0)', async () => {
    // Simulate EPIPE by providing a ReadableStream body that yields one chunk
    // then throws an error with code 'EPIPE'. pumpToStdout's catch block treats
    // EPIPE as a graceful end-of-pipe rather than a hard failure.
    server.use(
      http.get('https://api.freelo.io/v1/file/:uuid', () => {
        const firstChunk = new Uint8Array([0xde, 0xad]);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(firstChunk);
            const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
            controller.error(epipe);
          },
        });
        return new HttpResponse(stream, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="epipe.bin"',
            'Content-Length': '4',
          },
        });
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '--stdout',
      '--output',
      'json',
    ]);

    // EPIPE is graceful: the process should exit 0.
    expect(exitCode).toBe(0);
    // The envelope must still be emitted on stderr.
    const env = parseFirstJson(stderr) as {
      schema: string;
      data: { destination: string; bytes: number };
    };
    expect(env.schema).toBe('freelo.files.download/v1');
    expect(env.data.destination).toBe('stdout');
    // bytes reflects how many were counted before the EPIPE.
    expect(typeof env.data.bytes).toBe('number');
  });

  it('non-EPIPE error from body iterator piped to stdout is wrapped in NetworkError (exit 5)', async () => {
    // Use a mid-stream MSW handler that throws a generic error (not EPIPE).
    // By passing --stdout, this exercises the pumpToStdout catch branch for
    // non-EPIPE errors rather than the pumpToFile branch.
    server.use(
      filesDownloadHandlers.midStreamError({
        firstChunk: new Uint8Array([0x01, 0x02]),
        declaredLength: 1024,
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '--stdout',
      '--output',
      'json',
    ]);

    // A non-EPIPE stream error must surface as NetworkError (exit 5).
    expect(exitCode).toBe(5);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('NETWORK_ERROR');
  });
});

/* ---------------------------------------------------------------------------
 *  pumpToFile rename-failure branch (Calibration §4 — cover the catch arm
 *  at src/commands/files/download.ts lines 364-373).
 * ------------------------------------------------------------------------- */

describe('freelo files download — pumpToFile rename failure', () => {
  it('rename failure after temp write is wrapped in NetworkError, temp file is cleaned up', async () => {
    // Mock node:fs/promises.rename to throw on its first call so the temp file
    // is written successfully but the atomic rename step fails. Spread the real
    // module so every other fs op (open, write, unlink) keeps working.
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      let renameCalls = 0;
      return {
        ...actual,
        rename: vi.fn(async (oldPath: string, newPath: string) => {
          renameCalls += 1;
          if (renameCalls === 1) {
            throw Object.assign(new Error('rename failed (synthetic)'), { code: 'EISDIR' });
          }
          return actual.rename(oldPath, newPath);
        }),
      };
    });
    vi.resetModules();

    const fixture = Buffer.from('content');
    server.use(filesDownloadHandlers.downloadOk({ bytes: fixture, contentType: 'text/plain' }));
    const dest = join(testDir, 'rename-fail.bin');

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '-o',
      dest,
      '--output',
      'json',
    ]);

    // Rename failure surfaces as NetworkError (exit 5).
    expect(exitCode).toBe(5);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('NETWORK_ERROR');
    expect(env.error.message).toMatch(/Failed to finalize/);

    // Temp file cleanup: the destination directory should not contain a
    // leftover .tmp file from this run.
    const remaining = await readdir(testDir);
    expect(remaining.some((f) => f.endsWith('.tmp'))).toBe(false);
    // And the destination itself was never created.
    await expect(stat(dest)).rejects.toMatchObject({ code: 'ENOENT' });

    vi.doUnmock('node:fs/promises');
  });

  it('rename failure + unlink cleanup failure: NetworkError still surfaces (inner catch is silent)', async () => {
    // Both rename AND the cleanup unlink throw. The inner catch at
    // src/commands/files/download.ts:366-368 swallows the unlink error so
    // the rename failure is still the surfaced error.
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return {
        ...actual,
        rename: vi.fn(() => {
          return Promise.reject(
            Object.assign(new Error('rename failed (synthetic)'), { code: 'EISDIR' }),
          );
        }),
        unlink: vi.fn(() => {
          return Promise.reject(
            Object.assign(new Error('unlink failed (synthetic)'), { code: 'EACCES' }),
          );
        }),
      };
    });
    vi.resetModules();

    const fixture = Buffer.from('content');
    server.use(filesDownloadHandlers.downloadOk({ bytes: fixture, contentType: 'text/plain' }));
    const dest = join(testDir, 'rename-and-unlink-fail.bin');

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'files',
      'download',
      TEST_UUID,
      '-o',
      dest,
      '--output',
      'json',
    ]);

    // Rename failure still surfaces; the unlink-cleanup failure is silently
    // swallowed by the inner catch.
    expect(exitCode).toBe(5);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('NETWORK_ERROR');
    expect(env.error.message).toMatch(/Failed to finalize/);

    vi.doUnmock('node:fs/promises');
  });
});

/* ---------------------------------------------------------------------------
 *  pumpToStdout backpressure-drain branch (Calibration §4 — cover the
 *  `if (!ok) await drain` branch at src/commands/files/download.ts 388-393).
 * ------------------------------------------------------------------------- */

describe('freelo files download — pumpToStdout backpressure drain', () => {
  it('awaits drain when process.stdout.write signals backpressure (returns false)', async () => {
    // Override the default captureOutput stdout spy: return false for the
    // first chunk to trigger the if (!ok) branch and a synthetic 'drain'
    // event so the awaiting Promise resolves promptly.
    const writeCallbacks: Array<string | Uint8Array> = [];
    let firstChunkSeen = false;
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      const c = typeof chunk === 'string' || chunk instanceof Uint8Array ? chunk : String(chunk);
      writeCallbacks.push(c);
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        // Schedule a 'drain' immediately — pumpToStdout will register a
        // one-shot listener after we return false; setImmediate fires once
        // the microtask queue clears, after the listener is attached.
        setImmediate(() => process.stdout.emit('drain'));
        return false;
      }
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`EXIT:${Number(code ?? 0)}`);
      });

    const fixture = Buffer.from('xxxxxxxxxxxxxxxxxx'); // 18 bytes; one chunk plenty
    server.use(filesDownloadHandlers.downloadOk({ bytes: fixture, contentType: 'text/plain' }));

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      let exitCode = 0;
      try {
        await run(['node', 'freelo', 'files', 'download', TEST_UUID, '--stdout']);
      } catch (err) {
        const m = /^EXIT:(\d+)$/.exec(err instanceof Error ? err.message : '');
        if (m !== null && m[1] !== undefined) exitCode = Number(m[1]);
      }
      // Backpressure path is graceful — process should exit 0.
      expect(exitCode).toBe(0);
      // The drain branch was hit at least once (write returned false then true).
      expect(firstChunkSeen).toBe(true);
    } finally {
      writeSpy.mockRestore();
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
