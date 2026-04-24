import { type HttpClient, type ApiResponse } from './client.js';
import { UserMeEnvelopeSchema, type UserMeEnvelope } from './schemas/users-me.js';

export type GetUsersMeResult = {
  user: UserMeEnvelope['user'];
  raw: ApiResponse<UserMeEnvelope>;
};

/**
 * Call `GET /users/me` and return the parsed user object together with the
 * raw `ApiResponse` (for rate-limit metadata).
 */
export async function getUsersMe(
  client: HttpClient,
  opts: { signal?: AbortSignal; requestId?: string },
): Promise<GetUsersMeResult> {
  const raw = await client.request({
    method: 'GET',
    path: '/users/me',
    schema: UserMeEnvelopeSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { user: raw.data.user, raw };
}
