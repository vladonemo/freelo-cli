import { type Command } from 'commander';
import { type GetAppConfig } from '../../config/schema.js';
import { buildSourceMap } from '../../config/resolve.js';
import { buildConfigListData } from '../../config/list.js';
import { hasToken } from '../../config/has-token.js';
import { readStore } from '../../config/store.js';
import { buildEnvelope } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderConfigListHuman } from '../../ui/human/config-list.js';
import { handleTopLevelError } from '../../errors/handle.js';

export const meta = {
  outputSchema: 'freelo.config.list/v1',
  destructive: false,
} as const;

export function registerList(
  config: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  config
    .command('list')
    .description('List all configuration keys with current values and sources.')
    .action(async () => {
      const appConfig = getConfig();
      const mode = appConfig.output.mode;

      try {
        const sourceMap = buildSourceMap({ env, flags: {} });
        const tokenPresent = await hasToken(appConfig.profile);

        // Retrieve email from the active profile's store record (mirrors resolve.ts §8.6.3)
        let email: string | null = null;
        try {
          const store = readStore();
          email = store.profiles[appConfig.profile]?.email ?? null;
        } catch {
          // Store may not exist on a fresh install — that's fine, email = null → ''
        }

        const data = buildConfigListData(appConfig, sourceMap, tokenPresent, email);

        const envelope = buildEnvelope({
          schema: 'freelo.config.list/v1',
          data,
          requestId: appConfig.requestId,
        });

        render(mode, envelope, renderConfigListHuman);
      } catch (err: unknown) {
        handleTopLevelError(err, mode);
      }
    });
}
