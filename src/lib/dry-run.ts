import { type Envelope, type SchemaString } from '../ui/envelope.js';

/**
 * Shared "would have" wire-call descriptor for `--dry-run` envelopes.
 *
 * Carries the HTTP method, fully-resolved path, and the JSON-serializable
 * request body that *would* have gone on the wire. Agents read this to
 * verify what a write command was going to do without actually doing it.
 *
 * Spec 0019 §3.2 / decision 8.
 */
export type Would = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body: unknown;
};

export type DryRunEnvelopeOptions<T extends Record<string, unknown>> = {
  schema: SchemaString;
  /** The envelope's `data` payload, sans `would`. The builder splices `would` in. */
  data: T;
  /** The descriptor of the call that would have happened. */
  would: Would;
  requestId?: string;
  notice?: string;
};

/**
 * Build a `dry_run: true` success envelope. Reused by every later write slice
 * (R10 edit, R11 finish/reopen, R12 move, R13 delete). Pure, no I/O.
 *
 * The output envelope:
 *   - has `dry_run: true` at the top level (so `Envelope<T>` consumers can
 *     branch on it without inspecting `data`);
 *   - splices the `would` descriptor into `data.would` so the descriptor
 *     travels with the rest of the per-call context (tasklist_id, etc.);
 *   - carries no `rate_limit` (no HTTP call happened) and a `request_id` only
 *     when the caller supplies one (e.g. for end-to-end tracing where the
 *     dry-run is part of a larger flow).
 *
 * Spec 0019 §3.2.
 */
export function dryRunEnvelope<T extends Record<string, unknown>>(
  opts: DryRunEnvelopeOptions<T>,
): Envelope<T & { would: Would }> {
  const data = { ...opts.data, would: opts.would } as T & { would: Would };
  const env: Envelope<T & { would: Would }> = {
    schema: opts.schema,
    data,
    dry_run: true,
  };
  if (opts.requestId !== undefined) env.request_id = opts.requestId;
  if (opts.notice !== undefined) env.notice = opts.notice;
  return env;
}
