/**
 * Read all bytes from stdin until EOF, then return as a UTF-8 string.
 *
 * - Never throws on a closed / empty stdin; returns `""`.
 * - With `trimTrailingNewline: true` (default), strips a single trailing `\n`
 *   or `\r\n` so `echo -n key | freelo auth login --api-key-stdin` and
 *   `echo key | freelo auth login --api-key-stdin` both work.
 * - Respects `signal`; if aborted mid-read, returns whatever was read so far
 *   (callers should check `signal.aborted` afterward if precision matters).
 */
export async function readStdinToString(opts?: {
  signal?: AbortSignal;
  trimTrailingNewline?: boolean;
}): Promise<string> {
  const { signal, trimTrailingNewline = true } = opts ?? {};

  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      let result = Buffer.concat(chunks).toString('utf8');
      if (trimTrailingNewline) {
        if (result.endsWith('\r\n')) {
          result = result.slice(0, -2);
        } else if (result.endsWith('\n')) {
          result = result.slice(0, -1);
        }
      }
      resolve(result);
    };
    const onError = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onAbort = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    const cleanup = (): void => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    if (signal?.aborted) {
      resolve('');
      return;
    }

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
