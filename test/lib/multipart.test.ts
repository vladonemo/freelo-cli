/**
 * Unit tests for `src/lib/multipart.ts` (R25, spec 0037 §7.1).
 *
 * Pure helper — no MSW. Real fs in a per-test tmp directory; cleanup runs
 * in `afterEach` so a failing assertion doesn't leak files into `os.tmpdir()`.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFileMultipart,
  FILE_UPLOAD_MAX_BYTES,
  FILE_UPLOAD_FIELD_NAME,
} from '../../src/lib/multipart.js';
import { ValidationError } from '../../src/errors/validation-error.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(
    tmpdir(),
    `freelo-multipart-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('buildFileMultipart', () => {
  it('returns a FormData with the file field and basename as filename', async () => {
    const path = join(tmpDir, 'hello.txt');
    await writeFile(path, 'hello world');

    const result = await buildFileMultipart(path);

    expect(result.filename).toBe('hello.txt');
    expect(result.bytes).toBe('hello world'.length);
    // FormData stores the file under FILE_UPLOAD_FIELD_NAME ('file').
    const got = result.body.get(FILE_UPLOAD_FIELD_NAME);
    expect(got).not.toBeNull();
    // File / Blob will have a `.name` and `.size` set by FormData.append.
    if (typeof got === 'object' && got !== null && 'size' in got) {
      expect((got as { size: number }).size).toBe('hello world'.length);
    }
  });

  it('reports the correct byte count for a 1024-byte file', async () => {
    const path = join(tmpDir, 'kilo.bin');
    await writeFile(path, Buffer.alloc(1024, 0x42));
    const result = await buildFileMultipart(path);
    expect(result.bytes).toBe(1024);
  });

  it('accepts an empty (0-byte) file (no minimum)', async () => {
    const path = join(tmpDir, 'empty.txt');
    await writeFile(path, '');
    const result = await buildFileMultipart(path);
    expect(result.bytes).toBe(0);
    expect(result.filename).toBe('empty.txt');
  });

  it('throws ValidationError when the path does not exist', async () => {
    const missing = join(tmpDir, 'does-not-exist.txt');
    await expect(buildFileMultipart(missing)).rejects.toBeInstanceOf(ValidationError);
    await expect(buildFileMultipart(missing)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 2,
    });
  });

  it('throws ValidationError when the path is a directory', async () => {
    await expect(buildFileMultipart(tmpDir)).rejects.toBeInstanceOf(ValidationError);
    await expect(buildFileMultipart(tmpDir)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('not a regular file') as unknown,
    });
  });

  it('throws ValidationError when size exceeds FILE_UPLOAD_MAX_BYTES', async () => {
    // Don't actually write 100 MB. Stub the file's `size` by mocking the
    // `node:fs/promises` `stat` import via vi.doMock so the multipart
    // helper sees a fake stat result. Reset modules to apply the mock —
    // and re-import ValidationError from the freshly-loaded module graph
    // so `instanceof` works (Calibration: vi.resetModules creates a
    // separate module instance for each subsequent import).
    const path = join(tmpDir, 'tiny.bin');
    await writeFile(path, 'tiny');

    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return {
        ...actual,
        stat: () =>
          Promise.resolve({
            isFile: () => true,
            size: FILE_UPLOAD_MAX_BYTES + 1,
          } as unknown as Awaited<ReturnType<typeof actual.stat>>),
      };
    });
    vi.resetModules();
    try {
      const { buildFileMultipart: bfmMocked } = await import('../../src/lib/multipart.js');
      const { ValidationError: VE } = await import('../../src/errors/validation-error.js');
      await expect(bfmMocked(path)).rejects.toBeInstanceOf(VE);
      await expect(bfmMocked(path)).rejects.toMatchObject({
        exitCode: 2,
        message: expect.stringMatching(/100 MB|exceeds/) as unknown,
      });
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('exports the documented field name and limit constants', () => {
    expect(FILE_UPLOAD_FIELD_NAME).toBe('file');
    expect(FILE_UPLOAD_MAX_BYTES).toBe(100 * 1024 * 1024);
  });
});
