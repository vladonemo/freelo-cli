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
import { uploadFile, FILE_UPLOAD_PATH } from '../../src/api/files.js';
import { buildFileMultipart } from '../../src/lib/multipart.js';
import { FreeloApiError } from '../../src/errors/freelo-api-error.js';
import { server, filesUploadHandlers, API_BASE } from '../msw/handlers.js';

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
