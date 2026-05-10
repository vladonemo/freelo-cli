/**
 * `freelo custom-fields enum list --field <uuid>` (R43, spec 0057).
 *
 * Read-only. Returns enum options defined on an enum-typed custom field. Wire:
 * `GET /custom-field-enum/get-for-custom-field/{uuid}` (yaml :4326-4359).
 *
 * Empty `options: []` is a valid 200 (the field is enum-typed but has no
 * options yet, or all options were soft-deleted).
 *
 * No `--dry-run` — the command is read-only and dry-run on a pure GET is a
 * no-op surprise (mirrors R40 spec 0054 decision 5).
 *
 * Output schema: `freelo.custom-fields.enum-list/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../../config/schema.js';
import { resolveCredentials } from '../../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../../api/client.js';
import { getCustomFieldEnum } from '../../../api/custom-fields.js';
import { type CustomFieldsEnumListData } from '../../../api/schemas/custom-field.js';
import { buildEnvelope, type SchemaString } from '../../../ui/envelope.js';
import { render } from '../../../ui/render.js';
import { renderCustomFieldsEnumListHuman } from '../../../ui/human/custom-fields-enum-list.js';
import { handleTopLevelError } from '../../../errors/handle.js';
import { ValidationError } from '../../../errors/validation-error.js';
import { FreeloApiError } from '../../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.custom-fields.enum-list/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.custom-fields.enum-list/v1';

type ListOpts = {
  field?: string;
};

function parseFieldFlag(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('--field must be a non-empty uuid.', {
      hintNext:
        '--field is a custom-field uuid. Run `freelo custom-fields list --project <id>` for ids.',
    });
  }
  return trimmed;
}

export function registerEnumList(
  enumCmd: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = enumCmd
    .command('list')
    .description(
      'List enum options defined on an enum-typed custom field. Empty result is valid (no options yet, or all soft-deleted). Read-only.',
    )
    .option('--field <uuid>', 'Custom-field uuid (required).', parseFieldFlag);
  attachMeta(cmd, meta);

  cmd.action(async (opts: ListOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      if (opts.field === undefined) {
        throw new ValidationError('--field is required.', {
          hintNext:
            'Pass --field <uuid>. Run `freelo custom-fields list --project <id>` to discover field uuids.',
        });
      }
      const fieldUuid = opts.field;

      const client = await buildClient(appConfig, env);
      let result: Awaited<ReturnType<typeof getCustomFieldEnum>>;
      try {
        result = await getCustomFieldEnum(client, fieldUuid, {
          requestId: appConfig.requestId,
        });
      } catch (err: unknown) {
        throw rewriteApiHint(err);
      }

      const data: CustomFieldsEnumListData = {
        field_uuid: fieldUuid,
        options: result.body.custom_field_enum,
      };
      const envelope = buildEnvelope({
        schema: SCHEMA,
        data,
        rateLimit: {
          remaining: result.raw.rateLimit.remaining,
          reset_at: result.raw.rateLimit.resetAt,
        },
        requestId: appConfig.requestId,
      });
      render(mode, envelope, (d) => renderCustomFieldsEnumListHuman(d));
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

/**
 * Map well-known `FreeloApiError` cases to friendlier hints (spec 0057 §2.4).
 */
function rewriteApiHint(err: unknown): unknown {
  if (!(err instanceof FreeloApiError)) return err;
  if (err.httpStatus === 400) {
    return rebrand(
      err,
      'Server-side validation rejected the request; verify --field is a valid uuid.',
    );
  }
  if (err.httpStatus === 403) {
    return rebrand(err, 'Account cannot read enum options on this custom field.');
  }
  if (err.httpStatus === 404) {
    return rebrand(
      err,
      'Custom field not found. Run `freelo custom-fields list --project <id>` for uuids.',
    );
  }
  return err;
}

function rebrand(err: FreeloApiError, hintNext: string): FreeloApiError {
  return new FreeloApiError(err.message, err.code, {
    ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
    errors: err.errors,
    rawBody: err.rawBody,
    hintNext,
  });
}
