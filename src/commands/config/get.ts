import { type Command } from 'commander';
import { type GetAppConfig } from '../../config/schema.js';
import { buildSourceMap } from '../../config/resolve.js';
import { buildConfigListData } from '../../config/list.js';
import { hasToken } from '../../config/has-token.js';
import { readStore } from '../../config/store.js';
import { buildEnvelope } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderConfigGetHuman } from '../../ui/human/config-get.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { isKnownKey } from '../../config/keys.js';

export const meta = {
  outputSchema: 'freelo.config.get/v1',
  destructive: false,
} as const;

export function registerGet(
  config: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  config
    .command('get <key>')
    .description(
      'Get the current value and source of a configuration key. ' +
        "Read-only keys (e.g. 'apiKey') return '[redacted]'.",
    )
    .action(async (key: string) => {
      const appConfig = getConfig();
      const mode = appConfig.output.mode;

      try {
        if (!isKnownKey(key)) {
          throw new ValidationError(
            `Unknown config key '${key}'. Run 'freelo config list' for available keys.`,
            {
              field: 'key',
              value: key,
              hintNext: "Run 'freelo config list' for the catalog of writable keys.",
            },
          );
        }

        const sourceMap = buildSourceMap({ env, flags: {} });
        const tokenPresent = await hasToken(appConfig.profile);

        // Retrieve email from the active profile's store record (mirrors resolve.ts §8.6.3)
        let email: string | null = null;
        try {
          const store = readStore();
          email = store.profiles[appConfig.profile]?.email ?? null;
        } catch {
          // Store may not exist on a fresh install — email defaults to null → ''
        }

        const listData = buildConfigListData(appConfig, sourceMap, tokenPresent, email);
        const entry = listData.keys.find((k) => k.key === key);

        if (!entry) {
          throw new ValidationError(
            `Unknown config key '${key}'. Run 'freelo config list' for available keys.`,
            { field: 'key', value: key },
          );
        }

        const envelope = buildEnvelope({
          schema: 'freelo.config.get/v1',
          data: entry,
          requestId: appConfig.requestId,
        });

        render(mode, envelope, renderConfigGetHuman);
      } catch (err: unknown) {
        handleTopLevelError(err, mode);
      }
    });
}
