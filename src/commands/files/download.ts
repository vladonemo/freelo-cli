/**
 * `freelo files download <uuid> [-o <path>] [--stdout] [--force]`
 * (R27, spec 0039).
 *
 * First binary-streaming command in the CLI. Pipeline:
 *   1. Validate `<uuid>` (strict UUID regex pre-flight; no network call yet).
 *   2. Validate flag combinations (`-o` xor `--stdout`; `--force` is
 *      meaningless with `--stdout`).
 *   3. Build credentials & client.
 *   4. `requestBinary` → opens the response, returns metadata + body iterable.
 *   5. Choose sink:
 *        - `--stdout`: pipe bytes to `process.stdout`. Envelope to stderr
 *          (per spec 0039 §3.4 matrix).
 *        - file (explicit `-o` or inferred from `Content-Disposition`):
 *          atomic temp + rename. Refuse to overwrite without `--force`.
 *   6. Emit `freelo.files.download/v1` envelope. Exit 0 on success.
 *
 * Schema: `freelo.files.download/v1`.
 */

import { resolve as resolvePath, isAbsolute, dirname, join, basename } from 'node:path';
import {
  stat as fsStat,
  open as fsOpen,
  rename as fsRename,
  unlink as fsUnlink,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { downloadFile } from '../../api/files.js';
import { type FilesDownloadData } from '../../api/schemas/file.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderFilesDownloadHuman } from '../../ui/human/files-download.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { NetworkError } from '../../errors/network-error.js';
import { isInteractive } from '../../lib/env.js';
import { sanitizeBasename } from '../../lib/filename.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.files.download/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.files.download/v1';

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type DownloadOpts = {
  outputPath?: string;
  stdout?: boolean;
  force?: boolean;
  spinner?: boolean;
};

/* ---------------------------------------------------------------------------
 *  Input parsers
 * ------------------------------------------------------------------------- */

function validateUuid(raw: string): string {
  if (!UUID_REGEX.test(raw)) {
    throw new ValidationError('<uuid> must be a UUID (8-4-4-4-12 hex pattern).', {
      hintNext: 'Pass a UUID from `freelo files list`.',
    });
  }
  return raw;
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerDownload(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = parent
    .command('download')
    .description(
      'Download a file by UUID. Streams the binary body to a local path (atomic write) or to stdout. Refuses to overwrite an existing destination unless --force is set.',
    )
    .argument('<uuid>', 'UUID of the file to download (from `freelo files list`).', validateUuid)
    .option(
      '-o, --output-path <path>',
      'Local destination path. Mutex with --stdout. If the path is an existing directory, the file is placed inside it using the inferred filename. Parent directory must exist.',
    )
    .option(
      '--stdout',
      'Stream binary bytes to stdout. JSON envelope is emitted on stderr in non-human modes; human mode is silent on stderr.',
    )
    .option(
      '--force',
      'Overwrite the destination if it already exists. Meaningless (and rejected) with --stdout.',
    )
    .option('--no-spinner', 'Disable the TTY progress spinner. Auto-disabled in CI / pipes.');
  attachMeta(cmd, meta);

  cmd.action(async (uuid: string, opts: DownloadOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // --- flag combination checks ----------------------------------------
      if (opts.outputPath !== undefined && opts.stdout === true) {
        throw new ValidationError('-o/--output-path and --stdout are mutually exclusive.', {
          hintNext: 'Pick one: -o <path> to write a file, or --stdout to pipe bytes.',
        });
      }
      if (opts.force === true && opts.stdout === true) {
        throw new ValidationError('--force is meaningless with --stdout.', {
          hintNext: 'Drop --force when piping to stdout (there is no destination to overwrite).',
        });
      }

      await runLive(uuid, opts, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Live flow
 * ------------------------------------------------------------------------- */

async function runLive(
  uuid: string,
  opts: DownloadOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const client = await buildClient(appConfig, env);

  // Spinner (TTY only, never with --stdout). Lazy import per Calibration #7
  // / spec 0039 decision 09.
  const spinnerEnabled = isInteractive() && opts.spinner !== false && opts.stdout !== true;
  let spinner:
    | {
        text: string;
        start: () => unknown;
        stop: () => unknown;
        succeed: () => unknown;
        fail: () => unknown;
      }
    | undefined;
  if (spinnerEnabled) {
    const { default: ora } = await import('ora');
    spinner = ora({ text: `Fetching ${uuid}…`, stream: process.stderr });
    spinner.start();
  }

  let result: Awaited<ReturnType<typeof downloadFile>>;
  try {
    result = await downloadFile(client, {
      uuid,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    spinner?.fail();
    throw err;
  }

  // After we have headers we can update the spinner with size / filename.
  if (spinner !== undefined) {
    const sizeText = result.contentLength !== null ? ` (${result.contentLength} B)` : '';
    spinner.text = `Downloading ${result.filename ?? uuid}${sizeText}…`;
  }

  // Sanitize the server-provided filename for fs use. The unsanitized
  // value lives on `result.filename` (we surface it in the envelope as
  // `filename` for trace correlation).
  const safeServerName = result.filename !== null ? sanitizeBasename(result.filename) : '';

  // ---- Sink resolution -------------------------------------------------
  let bytes = 0;
  let destination: string;
  let overwrote = false;

  if (opts.stdout === true) {
    // --stdout path: pipe to process.stdout, reroute envelope to stderr.
    destination = 'stdout';
    try {
      bytes = await pumpToStdout(result.body);
    } catch (err: unknown) {
      spinner?.fail();
      throw err;
    }
  } else {
    // File path: resolve destination, EEXIST check, atomic temp+rename.
    const resolved = await resolveDestination({
      outputPath: opts.outputPath,
      serverName: safeServerName,
      uuid,
    });
    destination = resolved;

    // EEXIST check unless --force.
    const existed = await pathExists(destination);
    if (existed && opts.force !== true) {
      spinner?.fail();
      throw new ValidationError(`Destination already exists: ${destination}`, {
        hintNext: 'Pass --force to overwrite, or pick a different -o path.',
      });
    }
    if (existed) overwrote = true;

    try {
      bytes = await pumpToFile(result.body, destination);
    } catch (err: unknown) {
      spinner?.fail();
      throw err;
    }
  }

  spinner?.succeed();

  // ---- Envelope --------------------------------------------------------
  const data: FilesDownloadData = {
    uuid,
    destination,
    bytes,
    filename: result.filename, // raw server-provided value (unsanitized)
    content_type: result.contentType,
    overwrote,
  };

  const envelope: Envelope<FilesDownloadData> = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: result.raw.rateLimit.remaining,
      reset_at: result.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });

  // Output routing per spec 0039 §3.4 matrix:
  //   --stdout: structured output → stderr; human → silent.
  //   default:  structured output → stdout; human → stdout summary.
  if (opts.stdout === true) {
    if (mode === 'human') {
      // Silent — user is piping bytes to a tool and chatter is noise.
      return;
    }
    process.stderr.write(`${JSON.stringify(envelope)}\n`);
    return;
  }
  render(mode, envelope, (d) => renderFilesDownloadHuman(d));
}

/* ---------------------------------------------------------------------------
 *  Destination resolver
 *
 *  Honors decision 10 (-o pointing to an existing dir resolves to
 *  <dir>/<inferred>) and the §3.3 fallback chain
 *  (Content-Disposition → <uuid>.bin).
 * ------------------------------------------------------------------------- */

async function resolveDestination(opts: {
  outputPath: string | undefined;
  serverName: string;
  uuid: string;
}): Promise<string> {
  const fallbackName = opts.serverName.length > 0 ? opts.serverName : `${opts.uuid}.bin`;

  if (opts.outputPath === undefined) {
    // No -o: write into CWD using the inferred name.
    return resolvePath(process.cwd(), fallbackName);
  }

  // -o was provided. If it is a path to an existing directory, resolve
  // <dir>/<fallback>. Otherwise treat it as the literal destination.
  const abs = isAbsolute(opts.outputPath)
    ? opts.outputPath
    : resolvePath(process.cwd(), opts.outputPath);

  let isDir = false;
  try {
    const s = await fsStat(abs);
    isDir = s.isDirectory();
  } catch {
    // ENOENT or other — treat as a literal-file destination. Validation
    // (parent-dir-missing) happens later in pumpToFile via fs.open.
    isDir = false;
  }

  return isDir ? resolvePath(abs, fallbackName) : abs;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsStat(p);
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------
 *  Sink: pump iterable to a file (atomic temp + rename, spec 0039 §5.3).
 * ------------------------------------------------------------------------- */

async function pumpToFile(body: AsyncIterable<Uint8Array>, destination: string): Promise<number> {
  const dir = dirname(destination);
  const base = basename(destination);
  const tempName = `${base}.${randomBytes(6).toString('hex')}.tmp`;
  const tempPath = join(dir, tempName);

  let handle;
  try {
    // O_EXCL on the temp file ensures we don't clobber a colliding temp from
    // another concurrent download (extremely unlikely given the random
    // suffix, but defensive). 0o600 keeps perms tight by default.
    handle = await fsOpen(tempPath, 'wx', 0o600);
  } catch (err: unknown) {
    // Most common: ENOENT on the parent dir (-o ./does-not-exist/file.bin)
    // or EACCES. Surface as ValidationError with a precise hint
    // (spec 0039 decision 11).
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`Cannot create temporary file in ${dir}: ${message}`, {
      hintNext: 'Verify the parent directory exists and is writable, or pick a different -o path.',
    });
  }

  let bytes = 0;
  try {
    for await (const chunk of body) {
      bytes += chunk.byteLength;
      // `handle.write(buffer)` returns once the bytes have been queued for
      // the kernel. We await sequentially — chunks must land in order.
      await handle.write(chunk);
    }
    await handle.close();
  } catch (err: unknown) {
    // Close + unlink (best-effort) before re-throwing.
    try {
      await handle.close();
    } catch {
      // ignore
    }
    try {
      await fsUnlink(tempPath);
    } catch {
      // ignore
    }
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new NetworkError(
      `Stream interrupted while writing ${destination}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // Atomic rename (same dir as destination).
  try {
    await fsRename(tempPath, destination);
  } catch (err: unknown) {
    try {
      await fsUnlink(tempPath);
    } catch {
      // ignore
    }
    throw new NetworkError(
      `Failed to finalize ${destination}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  return bytes;
}

/* ---------------------------------------------------------------------------
 *  Sink: pump iterable to process.stdout. EPIPE is treated as success.
 * ------------------------------------------------------------------------- */

async function pumpToStdout(body: AsyncIterable<Uint8Array>): Promise<number> {
  let bytes = 0;
  try {
    for await (const chunk of body) {
      bytes += chunk.byteLength;
      const ok = process.stdout.write(chunk);
      if (!ok) {
        // Backpressure — wait for drain.
        await new Promise<void>((resolveDrain) => {
          process.stdout.once('drain', resolveDrain);
        });
      }
    }
  } catch (err: unknown) {
    // EPIPE / ERR_STREAM_PREMATURE_CLOSE: consumer closed pipe early.
    // Treat as success (graceful end of pipeline).
    if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'EPIPE') {
      return bytes;
    }
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new NetworkError(
      `Stream interrupted while piping to stdout: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return bytes;
}

/* ---------------------------------------------------------------------------
 *  Helpers
 * ------------------------------------------------------------------------- */

async function buildClient(
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<HttpClient> {
  const creds = await resolveCredentials({
    profile: appConfig.profile,
    apiBaseUrl: appConfig.apiBaseUrl,
    env,
  });
  return createHttpClient({
    email: creds.email,
    apiKey: creds.apiKey,
    apiBaseUrl: creds.apiBaseUrl,
    userAgent: appConfig.userAgent,
  });
}
