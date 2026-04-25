import { type Command } from 'commander';
import { type GetAppConfig } from '../../config/schema.js';
import { isWritableKey, isReadOnlyKey, keyScope } from '../../config/keys.js';
import {
  readStore,
  unsetDefault,
  setCurrentProfile,
  setProfileApiBaseUrl,
} from '../../config/store.js';
import { type ConfigUnsetData } from '../../ui/human/config-unset.js';
import { buildEnvelope } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderConfigUnsetHuman } from '../../ui/human/config-unset.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { ConfigError } from '../../errors/config-error.js';
import { type Defaults } from '../../config/schema.js';
import { API_BASE_DEFAULT } from '../../config/resolve.js';

export const meta = {
  outputSchema: 'freelo.config.unset/v1',
  destructive: false,
} as const;

export function registerUnset(config: Command, getConfig: GetAppConfig): void {
  config
    .command('unset <key>')
    .description(
      "Remove a configuration key from the user conf store. Read-only keys cannot be unset via 'config'; " +
        "use 'freelo auth logout' for credentials.",
    )
    .action((key: string) => {
      const appConfig = getConfig();
      const mode = appConfig.output.mode;

      try {
        // Read-only key check
        if (isReadOnlyKey(key)) {
          throw new ValidationError(
            `Config key '${key}' is read-only and cannot be unset via 'config'. Use 'freelo auth logout' for credentials.`,
            {
              field: 'key',
              value: key,
              hintNext: "Run 'freelo auth logout' to remove credentials.",
            },
          );
        }

        // Unknown key check
        if (!isWritableKey(key)) {
          throw new ValidationError(
            `Unknown config key '${key}'. Run 'freelo config list' for the catalog of writable keys.`,
            {
              field: 'key',
              value: key,
              hintNext: "Run 'freelo config list' for the catalog of writable keys.",
            },
          );
        }

        const writableKey = key;
        const scope = keyScope(writableKey);
        const store = readStore();

        let previousValue: string | number | boolean | null;
        let removed: boolean;
        let envelopeScope: 'defaults' | 'profile';
        let envelopeProfile: string | null = null;

        if (scope === 'defaults') {
          const prev = store.defaults[writableKey as keyof Defaults];
          if (prev === undefined) {
            previousValue = null;
            removed = false;
          } else {
            // Coerce verbose to string for protocol consistency (§7 #6)
            previousValue =
              writableKey === 'verbose' && typeof prev === 'number'
                ? String(prev)
                : (prev as string | number | boolean);
            unsetDefault(writableKey as keyof Defaults);
            removed = true;
          }
          envelopeScope = 'defaults';
        } else if (scope === 'currentProfile') {
          // 'profile' key → clears currentProfile
          previousValue = store.currentProfile;
          removed = store.currentProfile !== null;
          setCurrentProfile(null);
          envelopeScope = 'defaults';
        } else {
          // scope === 'profile' — apiBaseUrl
          // Per §8.6.1: apiBaseUrl is required; unset resets to API_BASE_DEFAULT.
          const currentProfileName = appConfig.profile;
          if (!store.profiles[currentProfileName]) {
            throw new ConfigError(
              `No active profile '${currentProfileName}'. Run 'freelo auth login' first.`,
              { kind: 'missing-profile', profile: currentProfileName },
            );
          }
          const currentUrl = store.profiles[currentProfileName].apiBaseUrl;
          previousValue = currentUrl;
          // 'removed' is true only when the value differed from the default
          removed = currentUrl !== API_BASE_DEFAULT;
          // Reset to default (cannot literally remove because the field is required)
          setProfileApiBaseUrl(currentProfileName, API_BASE_DEFAULT);
          envelopeScope = 'profile';
          envelopeProfile = currentProfileName;
        }

        const data: ConfigUnsetData = {
          key,
          previous_value: previousValue,
          removed,
          scope: envelopeScope,
          profile: envelopeProfile,
        };

        const envelope = buildEnvelope({
          schema: 'freelo.config.unset/v1',
          data,
          requestId: appConfig.requestId,
        });

        render(mode, envelope, renderConfigUnsetHuman);
      } catch (err: unknown) {
        handleTopLevelError(err, mode);
      }
    });
}
