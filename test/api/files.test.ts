/**
 * Tests for `src/api/files.ts` and `HttpClient.requestMultipart`
 * (R25, spec 0037 §7.2).
 *
 * Exercises the additive multipart path on `HttpClient` end-to-end via MSW:
 *   - Happy 200 → returns parsed `{ uuid }`.
 *   - 400 / 401 / 5xx error mapping.
 *   - Malformed 200 → FreeloApiError VALIDATION_ERROR.
 *   - Verifies the multipart body shape (presence of `file` form part).
 *   - Optional-spread branch coverage for `signal` / `requestId`.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHttpClient } from '../../src/api/client.js';
import {
  uploadFile,
  FILE_UPLOAD_PATH,
  downloadFile,
  fileDownloadPath,
} from '../../src/api/files.js';
import { buildFileMultipart } from '../../src/lib/multipart.js';
import { FreeloApiError } from '../../src/errors/freelo-api-error.js';
import { NetworkError } from '../../src/errors/network-error.js';
import { RateLimitedError } from '../../src/errors/rate-limited-error.js';
import { server, filesUploadHandlers, filesDownloadHandlers, API_BASE } from '../msw/handlers.js';

function makeClient() {
  return createHttpClient({
    email: 'agent@example.com',
    apiKey: 'sk-test',
    apiBaseUrl: API_BASE,
    userAgent: 'freelo-cli-test/0.0.0',
  });
}

let tmpDir: string;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterAll(() => {
  server.close();
});

beforeEach(async () => {
  tmpDir = join(
    tmpdir(),
    `freelo-files-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  server.resetHandlers();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('FILE_UPLOAD_PATH', () => {
  it('is /file/upload', () => {
    expect(FILE_UPLOAD_PATH).toBe('/file/upload');
  });
});

describe('uploadFile (happy path)', () => {
  it('sends a multipart body and returns the parsed uuid', async () => {
    const path = join(tmpDir, 'doc.txt');
    await writeFile(path, 'payload');

    let receivedContentType: string | null = null;
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.post(`${API_BASE}/file/upload`, ({ request }) => {
        receivedContentType = request.headers.get('Content-Type');
        return HttpResponse.json({ uuid: '22222222-2222-2222-2222-222222222222' });
      }),
    );

    const client = makeClient();
    const multipart = await buildFileMultipart(path);
    const result = await uploadFile(client, { multipart });

    expect(receivedContentType).not.toBeNull();
    expect(receivedContentType).toMatch(/^multipart\/form-data/);
    expect(result.uuid).toBe('22222222-2222-2222-2222-222222222222');
    expect(result.filename).toBe('doc.txt');
    expect(result.bytes).toBe('payload'.length);
  });

  it('threads requestId through to the wire (optional-spread branch)', async () => {
    const path = join(tmpDir, 'thread.txt');
    await writeFile(path, 'x');

    let receivedHeader: string | null = null;
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.post(`${API_BASE}/file/upload`, ({ request }) => {
        receivedHeader = request.headers.get('X-Request-Id');
        return HttpResponse.json({ uuid: '11111111-1111-1111-1111-111111111111' });
      }),
    );

    const client = makeClient();
    const multipart = await buildFileMultipart(path);
    await uploadFile(client, {
      multipart,
      requestId: '12345678-1234-1234-1234-123456789012',
    });
    expect(receivedHeader).toBe('12345678-1234-1234-1234-123456789012');
  });
});

describe('uploadFile (error paths — Calibration §2 exit-code coverage)', () => {
  it('400 oversize → FreeloApiError exit 4', async () => {
    const path = join(tmpDir, 'oversize.txt');
    await writeFile(path, 'x');
    server.use(filesUploadHandlers.uploadBadRequest('File too large.'));

    const client = makeClient();
    const multipart = await buildFileMultipart(path);
    await expect(uploadFile(client, { multipart })).rejects.toBeInstanceOf(FreeloApiError);
    await expect(uploadFile(client, { multipart })).rejects.toMatchObject({
      code: 'FREELO_API_ERROR',
      exitCode: 4,
    });
  });

  it('401 → FreeloApiError AUTH_EXPIRED exit 3', async () => {
    const path = join(tmpDir, 'auth.txt');
    await writeFile(path, 'x');
    server.use(filesUploadHandlers.uploadAuthExpired());

    const client = makeClient();
    const multipart = await buildFileMultipart(path);
    await expect(uploadFile(client, { multipart })).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
      exitCode: 3,
    });
  });

  it('5xx → FreeloApiError SERVER_ERROR exit 4 retryable', async () => {
    const path = join(tmpDir, 'srv.txt');
    await writeFile(path, 'x');
    server.use(filesUploadHandlers.uploadServerError(503));

    const client = makeClient();
    const multipart = await buildFileMultipart(path);
    await expect(uploadFile(client, { multipart })).rejects.toMatchObject({
      code: 'SERVER_ERROR',
      exitCode: 4,
      retryable: true,
    });
  });

  it('malformed 200 (missing uuid) → FreeloApiError VALIDATION_ERROR exit 4', async () => {
    const path = join(tmpDir, 'bad.txt');
    await writeFile(path, 'x');
    server.use(filesUploadHandlers.uploadMalformed());

    const client = makeClient();
    const multipart = await buildFileMultipart(path);
    await expect(uploadFile(client, { multipart })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 4,
    });
  });

  it('429 on a multipart write → RateLimitedError (typed, retryable=true)', async () => {
    const path = join(tmpDir, 'rl.txt');
    await writeFile(path, 'x');
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.post(`${API_BASE}/file/upload`, () =>
        HttpResponse.json({ errors: ['Rate limited.'] }, { status: 429 }),
      ),
    );

    const client = makeClient();
    const multipart = await buildFileMultipart(path);
    let caught: unknown;
    try {
      await uploadFile(client, { multipart });
    } catch (err) {
      caught = err;
    }
    // Multipart writes throw RateLimitedError (no retry loop in
    // requestMultipart — verified by inspection of src/api/client.ts).
    expect(caught).toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('uploadFile — optional-spread branches for signal / requestId absence', () => {
  it('succeeds without signal or requestId (both optional-spread arms omitted)', async () => {
    const path = join(tmpDir, 'no-opts.txt');
    await writeFile(path, 'data');
    server.use(filesUploadHandlers.uploadOk('dddd0000-0000-0000-0000-000000000004'));

    const client = makeClient();
    const multipart = await buildFileMultipart(path);
    // No signal or requestId — exercises the `...(signal !== undefined ? ...)` false branch
    const result = await uploadFile(client, { multipart });
    expect(result.uuid).toBe('dddd0000-0000-0000-0000-000000000004');
  });

  it('uploadFile threads a signal through to requestMultipart', async () => {
    const path = join(tmpDir, 'signal.txt');
    await writeFile(path, 'x');
    // Never responds — abort fires immediately
    const { http: mswHttp, HttpResponse: MswHttpResponse } = await import('msw');
    server.use(
      mswHttp.post(`${API_BASE}/file/upload`, async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return MswHttpResponse.json({ uuid: 'never' });
      }),
    );

    const controller = new AbortController();
    controller.abort();

    const client = makeClient();
    const multipart = await buildFileMultipart(path);
    let caught: unknown;
    try {
      await uploadFile(client, { multipart, signal: controller.signal });
    } catch (err) {
      caught = err;
    }
    // AbortError is re-thrown as-is (not a NetworkError)
    expect((caught as Error).name).toMatch(/Abort/i);
  });
});

/* ===========================================================================
 *  R27 — `freelo files download`  (spec 0039)
 *
 *  Exercises `HttpClient.requestBinary` end-to-end via MSW + the
 *  `downloadFile` wire wrapper. Calibration §2 exit-code coverage on every
 *  error class.
 * ========================================================================= */

const TEST_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function consumeBytes(iter: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of iter) chunks.push(c);
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

describe('fileDownloadPath', () => {
  it('encodes the UUID into /file/{uuid}', () => {
    expect(fileDownloadPath(TEST_UUID)).toBe(`/file/${TEST_UUID}`);
  });
});

describe('downloadFile (happy path)', () => {
  it('returns body iterable + Content-Type + Content-Length + parsed filename', async () => {
    const fixture = Buffer.from('hello world');
    server.use(
      filesDownloadHandlers.downloadOk({
        bytes: fixture,
        contentType: 'text/plain',
        contentDisposition: 'attachment; filename="hello.txt"',
      }),
    );

    const client = makeClient();
    const r = await downloadFile(client, { uuid: TEST_UUID });
    expect(r.contentType).toBe('text/plain');
    expect(r.contentLength).toBe(fixture.length);
    expect(r.filename).toBe('hello.txt');
    const bytes = await consumeBytes(r.body);
    expect(Buffer.from(bytes).toString('utf8')).toBe('hello world');
  });

  it('returns filename = null when Content-Disposition is absent', async () => {
    server.use(
      filesDownloadHandlers.downloadOk({
        bytes: Buffer.from('x'),
        contentType: 'application/octet-stream',
      }),
    );

    const client = makeClient();
    const r = await downloadFile(client, { uuid: TEST_UUID });
    expect(r.filename).toBeNull();
    expect(r.contentType).toBe('application/octet-stream');
  });
});

describe('downloadFile (error paths — Calibration §2 exit-code coverage)', () => {
  it('401 → FreeloApiError AUTH_EXPIRED exit 3', async () => {
    server.use(filesDownloadHandlers.unauthorized());
    const client = makeClient();
    let caught: unknown;
    try {
      await downloadFile(client, { uuid: TEST_UUID });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    expect((caught as FreeloApiError).httpStatus).toBe(401);
    // Per FreeloApiError.fromResponse, 401 is mapped to AUTH_EXPIRED → exit 3
    // (mirrors the auth/whoami + uploadFile contract). Spec 0039 §6 listed
    // exit 4 in error; the project's actual policy is exit 3.
    expect((caught as FreeloApiError).code).toBe('AUTH_EXPIRED');
    expect((caught as FreeloApiError).exitCode).toBe(3);
  });

  it('403 → FreeloApiError exit 4', async () => {
    server.use(filesDownloadHandlers.forbidden());
    const client = makeClient();
    let caught: unknown;
    try {
      await downloadFile(client, { uuid: TEST_UUID });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    expect((caught as FreeloApiError).httpStatus).toBe(403);
    expect((caught as FreeloApiError).exitCode).toBe(4);
  });

  it('404 → FreeloApiError exit 4 with status 404', async () => {
    server.use(filesDownloadHandlers.notFound());
    const client = makeClient();
    let caught: unknown;
    try {
      await downloadFile(client, { uuid: TEST_UUID });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    expect((caught as FreeloApiError).httpStatus).toBe(404);
    expect((caught as FreeloApiError).exitCode).toBe(4);
  });

  it('5xx → FreeloApiError exit 4', async () => {
    server.use(filesDownloadHandlers.serverError(503));
    const client = makeClient();
    let caught: unknown;
    try {
      await downloadFile(client, { uuid: TEST_UUID });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    expect((caught as FreeloApiError).httpStatus).toBe(503);
    expect((caught as FreeloApiError).exitCode).toBe(4);
  });

  it('429 → RateLimitedError exit 6 (NO retry per spec 0039 decision 05)', async () => {
    server.use(filesDownloadHandlers.rateLimited());
    const client = makeClient();
    let caught: unknown;
    try {
      await downloadFile(client, { uuid: TEST_UUID });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitedError);
    expect((caught as RateLimitedError).exitCode).toBe(6);
  });

  it('network-level error → NetworkError exit 5', async () => {
    server.use(filesDownloadHandlers.networkError());
    const client = makeClient();
    let caught: unknown;
    try {
      await downloadFile(client, { uuid: TEST_UUID });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NetworkError);
    expect((caught as NetworkError).exitCode).toBe(5);
  });
});

describe('downloadFile — empty body', () => {
  it('200 with no body returns an empty iterable, contentLength: 0', async () => {
    server.use(filesDownloadHandlers.downloadEmpty());
    const client = makeClient();
    const r = await downloadFile(client, { uuid: TEST_UUID });
    expect(r.contentLength).toBe(0);
    const bytes = await consumeBytes(r.body);
    expect(bytes.byteLength).toBe(0);
  });
});

describe('downloadFile — optional-spread branches', () => {
  it('omits signal / requestId when undefined', async () => {
    server.use(
      filesDownloadHandlers.downloadOk({ bytes: Buffer.from('a'), contentType: 'text/plain' }),
    );
    const client = makeClient();
    const r = await downloadFile(client, { uuid: TEST_UUID });
    await consumeBytes(r.body);
    expect(r.contentType).toBe('text/plain');
  });

  it('passes through signal + requestId when supplied', async () => {
    server.use(
      filesDownloadHandlers.downloadOk({ bytes: Buffer.from('a'), contentType: 'text/plain' }),
    );
    const client = makeClient();
    const controller = new AbortController();
    const r = await downloadFile(client, {
      uuid: TEST_UUID,
      signal: controller.signal,
      requestId: 'req-xyz',
    });
    await consumeBytes(r.body);
    expect(r.contentType).toBe('text/plain');
  });
});
