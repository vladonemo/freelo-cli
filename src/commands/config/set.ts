import { type Command } from 'commander';
import { type GetAppConfig } from '../../config/schema.js';
import { isWritableKey, isReadOnlyKey, parseValue, keyScope } from '../../config/keys.js';
import {
  readStore,
  setDefault,
  setCurrentProfile,
  setProfileApiBaseUrl,
} from '../../config/store.js';
import { type ConfigSetData } from '../../ui/human/config-set.js';
import { buildEnvelope } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderConfigSetHuman } from '../../ui/human/config-set.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { ConfigError } from '../../errors/config-error.js';
import { type Defaults } from '../../config/schema.js';

export const meta = {
  outputSchema: 'freelo.config.set/v1',
  destructive: false,
} as const;

export function registerSet(config: Command, getConfig: GetAppConfig): void {
  config
    .command('set <key> <value>')
    .description(
      'Set a configuration key. Writable keys: output, color, profile, apiBaseUrl, verbose. ' +
        "Read-only keys (email, apiKey) must be updated via 'freelo auth login'.",
    )
    .action((key: string, rawValue: string) => {
      const appConfig = getConfig();
      const mode = appConfig.output.mode;

      try {
        // Read-only key check
        if (isReadOnlyKey(key)) {
          throw new ValidationError(
            `Config key '${key}' is read-only. Use 'freelo auth login' to update credentials.`,
            {
              field: 'key',
              value: key,
              hintNext: "Run 'freelo auth login' to update credentials.",
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
        const parsedValue = parseValue(writableKey, rawValue);
        const scope = keyScope(writableKey);
        const store = readStore();

        let previousValue: string | number | boolean | null;
        let envelopeScope: 'defaults' | 'profile';
        let envelopeProfile: string | null = null;

        if (scope === 'defaults') {
          previousValue = (store.defaults[writableKey as keyof Defaults] ?? null) as
            | string
            | number
            | boolean
            | null;
          // Coerce previous verbose to string for protocol consistency (§7 #6)
          if (writableKey === 'verbose' && typeof previousValue === 'number') {
            previousValue = String(previousValue);
          }
          setDefault(writableKey as keyof Defaults, parsedValue as Defaults[keyof Defaults]);
          envelopeScope = 'defaults';
        } else if (scope === 'currentProfile') {
          // 'profile' key — validate the target profile exists
          const targetProfile = parsedValue as string;
          if (!(targetProfile in store.profiles)) {
            throw new ValidationError(
              `Profile '${targetProfile}' does not exist. Run 'freelo auth login --profile ${targetProfile}' to create it.`,
              {
                field: 'key',
                value: targetProfile,
                hintNext: `Run 'freelo auth login --profile ${targetProfile}' to create it, then 'freelo config use ${targetProfile}'.`,
              },
            );
          }
          previousValue = store.currentProfile;
          setCurrentProfile(targetProfile);
          // The envelope reports scope='defaults' for the 'profile' key even though the
          // value is stored in store.currentProfile (not in store.defaults). The 'defaults'
          // scope here means "global / not tied to a specific profile", which is the correct
          // semantic for the caller — it's a process-wide switch, not a per-profile key.
          // This matches the spec §2.3 union ('defaults' | 'profile') which has no third
          // member for currentProfile; field additions would be a schema bump (CLAUDE.md).
          // Equivalent to running `freelo config use <n>`.
          envelopeScope = 'defaults';
        } else {
          // scope === 'profile' — apiBaseUrl
          const currentProfileName = appConfig.profile;
          if (!store.profiles[currentProfileName]) {
            throw new ConfigError(
              `No active profile '${currentProfileName}'. Run 'freelo auth login' first.`,
              { kind: 'missing-profile', profile: currentProfileName },
            );
          }
          previousValue = store.profiles[currentProfileName].apiBaseUrl;
          setProfileApiBaseUrl(currentProfileName, parsedValue as string);
          envelopeScope = 'profile';
          envelopeProfile = currentProfileName;
        }

        // Coerce verbose to string for wire protocol consistency (§7 #6)
        const envelopeValue =
          writableKey === 'verbose'
            ? String(parsedValue)
            : (parsedValue as string | number | boolean);

        const data: ConfigSetData = {
          key,
          previous_value: previousValue,
          value: envelopeValue,
          scope: envelopeScope,
          profile: envelopeProfile,
        };

        const envelope = buildEnvelope({
          schema: 'freelo.config.set/v1',
          data,
          requestId: appConfig.requestId,
        });

        render(mode, envelope, renderConfigSetHuman);
      } catch (err: unknown) {
        handleTopLevelError(err, mode);
      }
    });
}
