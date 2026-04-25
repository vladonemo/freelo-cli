import { type Command } from 'commander';
import { type PartialAppConfig, type GetAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import { getUsersMe } from '../../api/users.js';
import { buildEnvelope } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderWhoamiHuman, type WhoamiData } from '../../ui/human/auth-whoami.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { type ProfileSource } from '../../config/schema.js';

export const meta = {
  outputSchema: 'freelo.auth.whoami/v1',
  destructive: false,
} as const;

/** Map the credential source to the envelope's profile_source field. */
function mapSource(source: 'stdin' | 'env' | 'keytar' | 'conf-fallback'): ProfileSource {
  switch (source) {
    case 'stdin':
    case 'env':
      return 'env';
    case 'keytar':
    case 'conf-fallback':
      return 'conf';
  }
}

export function registerWhoami(
  auth: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  auth
    .command('whoami')
    .description('Show the currently authenticated user.')
    .action(async () => {
      const appConfig: PartialAppConfig = getConfig();
      const mode = appConfig.output.mode;
      const profile = appConfig.profile;

      try {
        const creds = await resolveCredentials({
          profile,
          apiBaseUrl: appConfig.apiBaseUrl,
          env,
        });

        const client = createHttpClient({
          email: creds.email,
          apiKey: creds.apiKey,
          apiBaseUrl: creds.apiBaseUrl,
          userAgent: appConfig.userAgent,
        });

        const { user, raw } = await getUsersMe(client, {
          requestId: appConfig.requestId,
        });

        const email =
          'email' in user && typeof user['email'] === 'string' ? user['email'] : creds.email;

        const fullName =
          'fullname' in user && typeof user['fullname'] === 'string' ? user['fullname'] : undefined;

        const data: WhoamiData = {
          profile,
          profile_source: mapSource(creds.source),
          user_id: user.id,
          email,
          api_base_url: creds.apiBaseUrl,
          ...(fullName !== undefined ? { full_name: fullName } : {}),
        };

        const rateLimit = raw.rateLimit;
        const envelope = buildEnvelope({
          schema: 'freelo.auth.whoami/v1',
          data,
          rateLimit: { remaining: rateLimit.remaining, reset_at: rateLimit.resetAt },
          requestId: appConfig.requestId,
        });

        render(mode, envelope, renderWhoamiHuman);
      } catch (err: unknown) {
        handleTopLevelError(err, mode);
      }
    });
}
