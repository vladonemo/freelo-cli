import { z } from 'zod';

/**
 * Schema for `.freelorc.*` project-level configuration files.
 *
 * Rules:
 * - `.strict()` — unknown keys (e.g. `apiKey`, `email`, typos) are rejected
 *   immediately with a parse error, which is surfaced as `corrupt-rc`.
 * - All keys optional — an empty `{}` is valid (no-op rc).
 * - No credential keys (`apiKey`, `email`) — the rc file is designed to be
 *   committed to a repo; credential-shaped keys hitting `.strict()` is an
 *   explicit failure mode so users get a clear error.
 * - `verbose` uses the numeric form (rc files are typed YAML/JSON; only the
 *   CLI `<value>` arg accepts string-coerced `'0'/'1'/'2'`).
 */
export const RcConfigSchema = z
  .object({
    output: z.enum(['auto', 'human', 'json', 'ndjson']).optional(),
    color: z.enum(['auto', 'never', 'always']).optional(),
    profile: z.string().min(1).optional(),
    apiBaseUrl: z.string().url().optional(),
    verbose: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  })
  .strict();

export type RcConfig = z.infer<typeof RcConfigSchema>;
