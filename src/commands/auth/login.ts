import { type Command } from 'commander';
import { buildPartialAppConfig, pickFlags } from '../../config/resolve.js';
import { createHttpClient } from '../../api/client.js';
import { getUsersMe } from '../../api/users.js';
import { writeProfile, setCurrentProfile, readStore } from '../../config/store.js';
import { writeToken } from '../../config/tokens.js';
import { buildEnvelope } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderLoginHuman, type LoginData } from '../../ui/human/auth-login.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { ConfigError } from '../../errors/config-error.js';
import { readStdinToString } from '../../lib/stdin.js';
import { isInteractive } from '../../lib/env.js';

export const meta = {
  outputSchema: 'freelo.auth.login/v1',
  destructive: false,
} as const;

const API_BASE_DEFAULT = 'https://api.freelo.io/v1';

export function registerLogin(auth: Command): void {
  auth
    .command('login')
    .description('Store credentials for a Freelo profile and verify them.')
    .option('--email <address>', 'Freelo account email address.')
    .option('--api-key-stdin', 'Read the API key from stdin (no echo). Requires --email.')
    .action(async (opts: { email?: string; apiKeyStdin?: boolean }, cmd: Command) => {
      const globalOpts =
        cmd.parent?.parent?.opts<Record<string, string | number | boolean | undefined>>() ?? {};
      const appConfig = buildPartialAppConfig({
        env: process.env,
        flags: pickFlags(globalOpts),
      });

      const mode = appConfig.output.mode;
      const profile = appConfig.profile;

      try {
        let stdinApiKey: string | undefined;
        if (opts.apiKeyStdin) {
          if (!opts.email) {
            throw new ValidationError('Option --api-key-stdin requires --email.', {
              field: '--email',
            });
          }
          stdinApiKey = await readStdinToString({ trimTrailingNewline: true });
          if (!stdinApiKey) {
            throw new ValidationError('--api-key-stdin: no API key received from stdin.', {
              field: '--api-key-stdin',
            });
          }
        }

        const hasEnv =
          Boolean(process.env['FREELO_API_KEY']) && Boolean(process.env['FREELO_EMAIL']);
        const interactive = isInteractive() && !opts.apiKeyStdin && !hasEnv;

        let email: string;
        let apiKey: string;

        if (stdinApiKey) {
          email = opts.email!;
          apiKey = stdinApiKey;
        } else if (hasEnv) {
          email = opts.email ?? process.env['FREELO_EMAIL']!;
          if (opts.email && opts.email !== process.env['FREELO_EMAIL']) {
            throw new ValidationError(
              `--email '${opts.email}' does not match FREELO_EMAIL '${process.env['FREELO_EMAIL']}'.`,
              { field: '--email' },
            );
          }
          apiKey = process.env['FREELO_API_KEY']!;
        } else if (interactive) {
          const { input, password } = await import('@inquirer/prompts');

          if (!opts.email) {
            email = await input({
              message: 'Freelo account email:',
              validate: (v: string) => {
                if (!v.trim()) return 'Email is required.';
                if (!/.+@.+\..+/.test(v)) return 'Enter a valid email address.';
                return true;
              },
            });
          } else {
            email = opts.email;
          }

          const { default: ora } = await import('ora');
          const spinner = ora({ text: 'Verifying…', stream: process.stderr });

          apiKey = await password({
            message: 'Freelo API token:',
            mask: '*',
            validate: (v: string) => (v.trim() ? true : 'API token is required.'),
          });

          spinner.start();

          const apiBaseUrl = process.env['FREELO_API_BASE'] ?? API_BASE_DEFAULT;
          const client = createHttpClient({
            email,
            apiKey,
            apiBaseUrl,
            userAgent: appConfig.userAgent,
          });

          let result: Awaited<ReturnType<typeof getUsersMe>>;
          try {
            result = await getUsersMe(client, { requestId: appConfig.requestId });
          } finally {
            spinner.stop();
          }

          const store = readStore();
          const replaced = profile in store.profiles;
          await writeToken(profile, apiKey, { mode });
          writeProfile(profile, { email, apiBaseUrl });
          if (!store.currentProfile) setCurrentProfile(profile);

          const data: LoginData = {
            profile,
            email,
            user_id: result.user.id,
            replaced,
          };
          const rateLimit = result.raw.rateLimit;
          const envelope = buildEnvelope({
            schema: 'freelo.auth.login/v1',
            data,
            rateLimit: { remaining: rateLimit.remaining, reset_at: rateLimit.resetAt },
            requestId: appConfig.requestId,
            ...(replaced ? { notice: `Replaced token for profile '${profile}'.` } : {}),
          });
          render(mode, envelope, renderLoginHuman);
          return;
        } else {
          throw new ConfigError(
            'Credentials required in non-interactive mode.',
            { kind: 'missing-token', profile },
            { hintNext: 'Set FREELO_API_KEY and FREELO_EMAIL or pass --api-key-stdin.' },
          );
        }

        // Shared path for env + stdin.
        const apiBaseUrl = process.env['FREELO_API_BASE'] ?? API_BASE_DEFAULT;
        const client = createHttpClient({
          email,
          apiKey,
          apiBaseUrl,
          userAgent: appConfig.userAgent,
        });

        const result = await getUsersMe(client, { requestId: appConfig.requestId });

        const store = readStore();
        const replaced = profile in store.profiles;
        await writeToken(profile, apiKey, { mode });
        writeProfile(profile, { email, apiBaseUrl });
        if (!store.currentProfile) setCurrentProfile(profile);

        const data: LoginData = {
          profile,
          email,
          user_id: result.user.id,
          replaced,
        };
        const rateLimit = result.raw.rateLimit;
        const envelope = buildEnvelope({
          schema: 'freelo.auth.login/v1',
          data,
          rateLimit: { remaining: rateLimit.remaining, reset_at: rateLimit.resetAt },
          requestId: appConfig.requestId,
          ...(replaced ? { notice: `Replaced token for profile '${profile}'.` } : {}),
        });
        render(mode, envelope, renderLoginHuman);
      } catch (err: unknown) {
        handleTopLevelError(err, mode);
      }
    });
}
