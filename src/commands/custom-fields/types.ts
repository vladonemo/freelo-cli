/**
 * `freelo custom-fields types` (R40, spec 0054).
 *
 * Read-only. Returns the server-curated catalog of custom-field type
 * definitions (text / number / enum). Wire: `GET /custom-field/get-types`
 * (yaml :4012-4042). No path params, no flags.
 *
 * Each type's `uuid` is the value passed as `type` to
 * `POST /custom-field/create/{project_id}` (the future R41 command).
 *
 * No `--dry-run` — the command is read-only and dry-run on a pure GET is
 * a no-op surprise (spec 0054 decision 5).
 *
 * Output schema: `freelo.custom-fields.types/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { getCustomFieldTypes } from '../../api/custom-fields.js';
import {
  type CustomFieldsTypesData,
  type CustomFieldType,
} from '../../api/schemas/custom-field.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderCustomFieldsTypesHuman } from '../../ui/human/custom-fields-types.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.custom-fields.types/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.custom-fields.types/v1';

export function registerTypes(
  customFields: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = customFields
    .command('types')
    .description(
      'List the catalog of custom-field type definitions (text, number, enum). Each type uuid is the value to pass as `type` when creating a custom field on a project (R41 — future slice). Read-only.',
    );
  attachMeta(cmd, meta);

  cmd.action(async () => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      const client = await buildClient(appConfig, env);
      // appConfig.requestId is always defined (auto-generated when not flagged);
      // pass it through unconditionally rather than the dead-branchy spread.
      const result = await getCustomFieldTypes(client, { requestId: appConfig.requestId });

      const types: CustomFieldType[] = result.body.custom_field_types;
      const data: CustomFieldsTypesData = { types };
      const envelope = buildEnvelope({
        schema: SCHEMA,
        data,
        rateLimit: {
          remaining: result.raw.rateLimit.remaining,
          reset_at: result.raw.rateLimit.resetAt,
        },
        requestId: appConfig.requestId,
      });
      render(mode, envelope, (d) => renderCustomFieldsTypesHuman(d));
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

async function buildClient(
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<HttpClient> {
  const creds = await resolveCredentials({
    profile: appConfig.profile,
    apiBaseUrl: appConfig.apiBaseUrl,
    env,
  });
  return createHttpClient({
    email: creds.email,
    apiKey: creds.apiKey,
    apiBaseUrl: creds.apiBaseUrl,
    userAgent: appConfig.userAgent,
  });
}
