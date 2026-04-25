import { type Command } from 'commander';
import { type GetAppConfig } from '../../config/schema.js';
import { buildSourceMap } from '../../config/resolve.js';
import { buildConfigResolveData } from '../../config/resolve-data.js';
import { hasToken } from '../../config/has-token.js';
import { readStore } from '../../config/store.js';
import { buildEnvelope } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderConfigResolveHuman } from '../../ui/human/config-resolve.js';
import { handleTopLevelError } from '../../errors/handle.js';

export const meta = {
  outputSchema: 'freelo.config.resolve/v1',
  destructive: false,
} as const;

export function registerResolve(
  config: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  config
    .command('resolve')
    .description(
      'Print the merged effective configuration with optional per-leaf source annotation.',
    )
    .option(
      '--show-source',
      'Annotate each leaf with its source (flag|env|rc|conf|default).',
      false,
    )
    .action(async (opts: { showSource: boolean }) => {
      const appConfig = getConfig();
      const mode = appConfig.output.mode;

      try {
        const sourceMap = buildSourceMap({ env, flags: {} });
        const tokenPresent = await hasToken(appConfig.profile);

        // Retrieve email from the active profile's store record (§8.6.3)
        let email = '';
        try {
          const store = readStore();
          email = store.profiles[appConfig.profile]?.email ?? '';
        } catch {
          // Store may not exist on a fresh install — that's fine, email = ''
        }

        const data = buildConfigResolveData(appConfig, email, tokenPresent, sourceMap, {
          showSource: opts.showSource,
        });

        const envelope = buildEnvelope({
          schema: 'freelo.config.resolve/v1',
          data,
          requestId: appConfig.requestId,
        });

        render(mode, envelope, renderConfigResolveHuman);
      } catch (err: unknown) {
        handleTopLevelError(err, mode);
      }
    });
}
