import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * R05.5 Bug #3 — Windows libuv UV_HANDLE_CLOSING regression.
 *
 * The 0.5.1 unit test asserted a proxy condition (`getGlobalDispatcher().close()`
 * was called before `process.exit`). The bug shipped because the proxy
 * is not the real condition — calibration log §1.
 *
 * This test asserts the **real condition**:
 *
 *   On Windows, after a deliberate zod-validation failure, the spawned
 *   CLI process exits with the right code AND its stderr is free of
 *   `UV_HANDLE_CLOSING` / `Assertion failed:`.
 *
 * Test strategy:
 *  - Stand up a tiny `node:http` stub server on 127.0.0.1.
 *  - Stub returns 200 with a `/users/me`-shaped body that omits `user.id` —
 *    forces `UserMeSchema` to reject and `FreeloApiError` (exit 4) to fire.
 *  - Spawn the built CLI (`dist/freelo.js`) as a real child process via
 *    `spawn` (async — `spawnSync` would block the test runner's event
 *    loop and starve the stub server), pointed at the stub via
 *    `FREELO_API_BASE`. This produces a real Node process boundary
 *    (MSW would not — it patches in-process).
 *  - Assert exit code, stderr free of the libuv assertion strings, and
 *    a parseable `freelo.error/v1` envelope on stderr.
 *
 * Skipped on macOS/Linux — the libuv assertion is Windows-only. The unit
 * test in `test/errors/handle.test.ts` covers `.destroy()` + `setImmediate`
 * call ordering on every platform.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

/**
 * We invoke the CLI as `node --import tsx src/bin/freelo.ts` rather than
 * `node dist/freelo.js`, so the test does not depend on a `pnpm build`
 * step running first. The bundled output and the source-driven invocation
 * use the same module graph (same undici dispatcher, same error handler),
 * so the libuv condition reproduces identically. `--import tsx` is the
 * Node 20+ idiom for transpiling TypeScript on the fly.
 */
const entryPath = resolve(repoRoot, 'src', 'bin', 'freelo.ts');

interface StubServer {
  server: Server;
  port: number;
  baseUrl: string;
}

function startStubServer(): Promise<StubServer> {
  return new Promise((resolveStart, rejectStart) => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      // Force a zod failure: return a /users/me-shaped body where `user.id`
      // is missing. UserMeSchema requires `id: z.number().int().positive()`.
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: 'success', user: { fullname: 'no id field' } }));
    });
    server.on('error', rejectStart);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'string' || addr === null) {
        rejectStart(new Error('unexpected server.address() shape'));
        return;
      }
      resolveStart({
        server,
        port: addr.port,
        baseUrl: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

function stopStubServer(stub: StubServer): Promise<void> {
  return new Promise((res) => {
    stub.server.close(() => {
      res();
    });
  });
}

describe.runIf(process.platform === 'win32')(
  'R05.5 Bug #3 — Windows libuv UV_HANDLE_CLOSING regression (subprocess)',
  () => {
    let stub: StubServer;

    beforeAll(async () => {
      stub = await startStubServer();
    });

    afterAll(async () => {
      await stopStubServer(stub);
    });

    it('CLI exits cleanly with no UV_HANDLE_CLOSING in stderr after a zod-validation failure', async () => {
      // `spawn` (async). `spawnSync` would block the test runner's event
      // loop, starving the in-process stub server.
      const result = await new Promise<{
        status: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
      }>((resolveSpawn, rejectSpawn) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', entryPath, 'auth', 'whoami', '--output', 'json'],
          {
            env: {
              ...process.env,
              FREELO_API_KEY: 'sk-libuv-regression',
              FREELO_EMAIL: 'libuv-regression@example.com',
              FREELO_API_BASE: stub.baseUrl,
              FREELO_NO_KEYCHAIN: '1',
              FREELO_PROFILE: 'default',
              // Avoid TTY-detection paths and color codes.
              NO_COLOR: '1',
            },
          },
        );

        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });

        const watchdog = setTimeout(() => {
          child.kill('SIGKILL');
          rejectSpawn(new Error('child did not exit within 10s — possible libuv hang'));
        }, 10_000);

        child.on('error', (err) => {
          clearTimeout(watchdog);
          rejectSpawn(err);
        });
        child.on('exit', (status, signal) => {
          clearTimeout(watchdog);
          resolveSpawn({ status, signal, stdout, stderr });
        });
      });

      const { stderr, stdout } = result;

      // Real condition #1: stderr is free of the libuv assertion strings.
      // These are the exact substrings emitted by libuv on the crash:
      //
      //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
      //     file src\\win\\async.c, line 76
      expect(stderr).not.toContain('UV_HANDLE_CLOSING');
      expect(stderr).not.toContain('Assertion failed:');

      // Real condition #2: clean exit code. FreeloApiError → exit 4.
      // A libuv crash typically produces exit code 134 (SIGABRT) or
      // the Windows STATUS_ABANDONED 0xC0000354 cast to int.
      expect(result.status).toBe(4);
      expect(result.signal).toBeNull();

      // Real condition #3: a parseable freelo.error/v1 envelope is on stderr.
      // The handler writes the envelope before draining the dispatcher, so
      // even if the libuv crash were to reproduce we'd still see this — but
      // we assert it explicitly so a regression in the envelope shape is also
      // caught here.
      const envelopeLine = stderr.split(/\r?\n/).find((line) => line.trim().startsWith('{'));
      expect(envelopeLine).toBeDefined();
      const envelope = JSON.parse(envelopeLine ?? '{}') as {
        schema?: string;
        error?: { code?: string };
      };
      expect(envelope.schema).toBe('freelo.error/v1');
      expect(envelope.error?.code).toBe('VALIDATION_ERROR');

      // stdout MUST be empty — structured errors go to stderr only.
      expect(stdout).toBe('');
    });
  },
);
