import { z } from 'zod';

/**
 * The `user` object inside a `/users/me` 200 response.
 *
 * Only `id` is documented in OpenAPI (freelo-api.yaml:118-126).
 * `.passthrough()` preserves undocumented fields (email, fullname, avatar_url)
 * that real responses are known to carry — tightened once a real fixture is
 * captured (see spec §3 Quirks 2).
 */
export const UserMeSchema = z
  .object({
    id: z.number().int().positive(),
    // Known extra fields preserved via passthrough; explicit typing deferred.
  })
  .passthrough();

export type UserMe = z.infer<typeof UserMeSchema>;

/**
 * Top-level `/users/me` 200 response.
 *
 * Both `result` and `user` are documented as `required`.
 * `.passthrough()` preserves any additional top-level fields.
 */
export const UserMeEnvelopeSchema = z
  .object({
    result: z.string(),
    user: UserMeSchema,
  })
  .passthrough();

export type UserMeEnvelope = z.infer<typeof UserMeEnvelopeSchema>;
