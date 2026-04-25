import { type Command } from 'commander';
import { type GetAppConfig } from '../../config/schema.js';
import { readStore } from '../../config/store.js';
import { type ConfigProfilesData } from '../../ui/human/config-profiles.js';
import { buildEnvelope } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderConfigProfilesHuman } from '../../ui/human/config-profiles.js';
import { handleTopLevelError } from '../../errors/handle.js';

export const meta = {
  outputSchema: 'freelo.config.profiles/v1',
  destructive: false,
} as const;

export function registerProfiles(config: Command, getConfig: GetAppConfig): void {
  config
    .command('profiles')
    .description('List all configured profiles.')
    .action(() => {
      const appConfig = getConfig();
      const mode = appConfig.output.mode;

      try {
        const store = readStore();
        const currentProfile = store.currentProfile;

        const profiles = Object.entries(store.profiles).map(([name, p]) => ({
          name,
          email: p.email,
          api_base_url: p.apiBaseUrl,
          current: name === currentProfile,
        }));

        const data: ConfigProfilesData = {
          current_profile: currentProfile,
          profiles,
        };

        const envelope = buildEnvelope({
          schema: 'freelo.config.profiles/v1',
          data,
          requestId: appConfig.requestId,
        });

        render(mode, envelope, renderConfigProfilesHuman);
      } catch (err: unknown) {
        handleTopLevelError(err, mode);
      }
    });
}
