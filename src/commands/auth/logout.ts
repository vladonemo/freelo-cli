import { type Command } from 'commander';
import { type PartialAppConfig, type GetAppConfig } from '../../config/schema.js';
import { removeProfile, readStore } from '../../config/store.js';
import { deleteToken } from '../../config/tokens.js';
import { buildEnvelope } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderLogoutHuman, type LogoutData } from '../../ui/human/auth-logout.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.auth.logout/v1',
  destructive: false,
};

export function registerLogout(auth: Command, getConfig: GetAppConfig): void {
  const logoutCmd = auth
    .command('logout')
    .description('Remove stored credentials for a Freelo profile.');
  attachMeta(logoutCmd, meta);
  logoutCmd.action(async () => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;
    const profile = appConfig.profile;

    try {
      const store = readStore();
      const profileExists = profile in store.profiles;

      await deleteToken(profile);

      if (profileExists) {
        removeProfile(profile);
      }

      const data: LogoutData = {
        profile,
        removed: profileExists,
      };

      const envelope = buildEnvelope({
        schema: 'freelo.auth.logout/v1',
        data,
        requestId: appConfig.requestId,
      });
      render(mode, envelope, renderLogoutHuman);
    } catch (err: unknown) {
      handleTopLevelError(err, mode);
    }
  });
}
