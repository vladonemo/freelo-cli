import { type ZodTypeAny, type z } from 'zod';
import { ValidationError } from '../errors/validation-error.js';

/**
 * Read all bytes from `stdin` (or any readable stream) and yield one
 * **non-empty** trimmed line at a time. Splits on `\n`, tolerates `\r\n`.
 * Empty lines (after trim) are skipped silently — agents emitting trailing
 * newlines or blank separators get sensible behavior for free.
 *
 * Streams chunks: callers may await each `for await (const line of …)` step
 * before more bytes arrive. We do NOT buffer the entire input in memory —
 * R09's batch mode handles arbitrarily long pipelines.
 *
 * Spec 0019 §3.5.
 */
export async function* iterateLines(
  source: NodeJS.ReadableStream,
): AsyncGenerator<string, void, void> {
  let buffer = '';
  // Set encoding only when the stream supports it (e.g. process.stdin).
  // Synthetic streams from `Readable.from(['…'])` already produce strings;
  // calling setEncoding on those is a no-op but harmless.
  if (typeof source.setEncoding === 'function') {
    try {
      source.setEncoding('utf8');
    } catch {
      // Some readable streams reject setEncoding after the iterator is taken;
      // ignore — we'll coerce chunks to string below.
    }
  }
  for await (const raw of source as AsyncIterable<string | Buffer>) {
    const chunk = typeof raw === 'string' ? raw : raw.toString('utf8');
    buffer += chunk;
    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      let line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const trimmed = line.trim();
      if (trimmed.length > 0) yield trimmed;
      newlineIdx = buffer.indexOf('\n');
    }
  }
  // Trailing line without a final newline.
  const tail = buffer.replace(/\r$/, '').trim();
  if (tail.length > 0) yield tail;
}

/**
 * Result of attempting to parse one NDJSON line through a zod schema. The
 * shape is a tagged union so callers branch on `ok` rather than destructuring
 * `value`/`error` defensively. `lineIndex` is 0-indexed across **non-empty**
 * input lines (matches what we yield from `iterateLines`).
 */
export type LineParseResult<T> =
  | { ok: true; value: T; lineIndex: number }
  | { ok: false; error: ValidationError; lineIndex: number };

/**
 * Parse one NDJSON line into a typed value via a zod schema. Pure, no I/O.
 *
 * Two failure paths, both materialized as `ValidationError` (exit 2):
 *   1. The line is not valid JSON.
 *   2. The line parses but fails the schema (unknown / wrong-type fields).
 *
 * Both attach a `hintNext` referencing the 1-indexed line number for human-
 * readable error messages — the underlying `lineIndex` stays 0-indexed for
 * the structured envelope.
 *
 * Spec 0019 §3.5.
 */
export function parseNdjsonLine<S extends ZodTypeAny>(
  line: string,
  lineIndex: number,
  schema: S,
): LineParseResult<z.output<S>> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      lineIndex,
      error: new ValidationError(`Line ${lineIndex + 1} is not valid JSON: ${detail}`, {
        hintNext: 'Each line must be a complete JSON object terminated by a newline.',
      }),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') ?? '<root>';
    const message = issue?.message ?? parsed.error.message;
    return {
      ok: false,
      lineIndex,
      error: new ValidationError(
        `Line ${lineIndex + 1}: ${path === '<root>' ? message : `${path} — ${message}`}`,
        { hintNext: 'See the command help for the per-line schema.' },
      ),
    };
  }
  return { ok: true, value: parsed.data as z.output<S>, lineIndex };
}

/**
 * Highest-of exit-code accumulator for batch streams.
 *
 * The policy (spec 0019 §3.5 / decision 7): when multiple lines fail with
 * different reasons, the **numerically highest** exit code wins. The repo's
 * error hierarchy uses 2 for validation, 3 for auth-expired, 4 for HTTP
 * errors (FreeloApiError), 5 for network, 6 for rate-limit. "Highest wins"
 * matches POSIX practice (the most-severe failure dominates) and means
 * agents get the strongest signal across the run.
 *
 * Implemented as a small mutable accumulator rather than a fold over an
 * array because the batch streamer flushes envelopes to stdout as they
 * complete — there's no array to fold.
 */
export class ExitCodeAccumulator {
  #current = 0;

  /** Merge another exit code into the running max. */
  observe(code: number): void {
    if (code > this.#current) this.#current = code;
  }

  get value(): number {
    return this.#current;
  }
}
