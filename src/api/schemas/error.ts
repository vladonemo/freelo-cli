import { z } from 'zod';

/**
 * Tolerant error body schema that handles both formats the Freelo API sends:
 *   - Global ErrorResponse: `{ errors: string[] }` (freelo-api.yaml:4803-4812)
 *   - /users/me 401:        `{ errors: Array<{ message: string }> }` (freelo-api.yaml:130-143)
 *
 * The two formats are incompatible; this union accepts both.
 * `.passthrough()` on the envelope tolerates unknown top-level fields.
 */
export const FreeloErrorBodySchema = z
  .object({
    errors: z.array(z.union([z.string(), z.object({ message: z.string() }).passthrough()])),
  })
  .passthrough();

export type FreeloErrorBody = z.infer<typeof FreeloErrorBodySchema>;

/**
 * Flatten either error body shape into `string[]` for display and envelope
 * emission.
 */
export function normalizeErrors(body: FreeloErrorBody): string[] {
  return body.errors.map((e) => (typeof e === 'string' ? e : e.message));
}
