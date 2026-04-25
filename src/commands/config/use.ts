import { type Command } from 'commander';
import { type GetAppConfig } from '../../config/schema.js';
import { readStore, setCurrentProfile } from '../../config/store.js';
import { type ConfigUseData } from '../../ui/human/config-use.js';
import { buildEnvelope } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderConfigUseHuman } from '../../ui/human/config-use.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.config.use/v1',
  destructive: false,
};

/**
 * `config use <profile>` — switch the active profile.
 *
 * No HTTP call per spec §7 #8. This is a pointer-move only; the user can
 * run `auth whoami` to verify the token still works after switching.
 *
 * Idempotent: switching to the already-active profile returns `changed: false`,
 * exit 0.
 *
 * Errors `CONFIG_PROFILE_NOT_FOUND` (ValidationError, exit 2) when the named
 * profile is not in the conf store. Does NOT auto-create profiles.
 */
export function registerUse(config: Command, getConfig: GetAppConfig): void {
  const useCmd = config
    .command('use <profile>')
    .description(
      "Switch the active profile. The profile must already exist (created via 'freelo auth login'). " +
        'No network call is made — use auth whoami to verify credentials afterward.',
    );
  attachMeta(useCmd, meta);
  useCmd.action((profile: string) => {
    const appConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      const store = readStore();

      if (!(profile in store.profiles)) {
        throw new ValidationError(`Profile '${profile}' does not exist.`, {
          field: 'profile',
          value: profile,
          hintNext: `Run 'freelo auth login --profile ${profile}' to create it, then 'freelo config use ${profile}'.`,
        });
      }

      const previousProfile = store.currentProfile;
      const changed = previousProfile !== profile;

      if (changed) {
        setCurrentProfile(profile);
      }

      const data: ConfigUseData = {
        previous_profile: previousProfile,
        profile,
        changed,
      };

      const envelope = buildEnvelope({
        schema: 'freelo.config.use/v1',
        data,
        requestId: appConfig.requestId,
      });

      render(mode, envelope, renderConfigUseHuman);
    } catch (err: unknown) {
      handleTopLevelError(err, mode);
    }
  });
}
