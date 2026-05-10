/**
 * `freelo custom-fields enum add --field <uuid> --value <str> [--dry-run]`
 * (R43, spec 0057).
 *
 * Adds an enum option to an enum-typed custom field. Wire:
 * `POST /custom-field-enum/create/{custom_field_uuid}` (yaml :4361-4414).
 *
 * Single-shot, non-destructive. ACL: project commander on the field's project.
 *
 * Output schema: `freelo.custom-fields.enum-add/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../../config/schema.js';
import { resolveCredentials } from '../../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../../api/client.js';
import { createCustomFieldEnum, createCustomFieldEnumPath } from '../../../api/custom-fields.js';
import { type CustomFieldsEnumAddData } from '../../../api/schemas/custom-field.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../../ui/envelope.js';
import { dryRunEnvelope } from '../../../lib/dry-run.js';
import { render } from '../../../ui/render.js';
import { renderCustomFieldsEnumAddHuman } from '../../../ui/human/custom-fields-enum-add.js';
import { handleTopLevelError } from '../../../errors/handle.js';
import { ValidationError } from '../../../errors/validation-error.js';
import { FreeloApiError } from '../../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.custom-fields.enum-add/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.custom-fields.enum-add/v1';

type AddOpts = {
  field?: string;
  value?: string;
  dryRun?: true;
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

export function registerEnumAdd(
  enumCmd: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = enumCmd
    .command('add')
    .description(
      "Add an enum option to an enum-typed custom field. Caller must be a project commander on the field's project. Server returns 400 if the target field is not enum-typed.",
    )
    .option('--field <uuid>', 'Custom-field uuid (required).', parseFieldFlag)
    .option('--value <str>', 'Display value of the new option (required, non-empty).')
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (opts: AddOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      if (opts.field === undefined) {
        throw new ValidationError('--field is required.', {
          hintNext:
            'Pass --field <uuid>. Run `freelo custom-fields list --project <id>` to discover field uuids.',
        });
      }
      if (opts.value === undefined || opts.value.trim().length === 0) {
        throw new ValidationError('--value is required and must be non-empty.', {
          hintNext: '`custom-fields enum add --field <uuid> --value "Option label"`.',
        });
      }
      await runAdd(opts.field, opts.value.trim(), opts.dryRun === true, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

async function runAdd(
  fieldUuid: string,
  value: string,
  isDryRun: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const body = { value };

  if (isDryRun) {
    const dryData: Pick<CustomFieldsEnumAddData, 'field_uuid'> = { field_uuid: fieldUuid };
    const envelope = dryRunEnvelope({
      schema: SCHEMA,
      data: dryData,
      would: { method: 'POST', path: createCustomFieldEnumPath(fieldUuid), body },
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    render(mode, envelope, (d) => renderCustomFieldsEnumAddHuman(d));
    return;
  }

  const client = await buildClient(appConfig, env);
  let result: Awaited<ReturnType<typeof createCustomFieldEnum>>;
  try {
    result = await createCustomFieldEnum(client, fieldUuid, {
      body,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    throw rewriteApiHint(err);
  }

  const data: CustomFieldsEnumAddData = {
    field_uuid: fieldUuid,
    option: result.body.custom_field_enum,
  };
  const envelope: Envelope<CustomFieldsEnumAddData> = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: result.raw.rateLimit.remaining,
      reset_at: result.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  render(mode, envelope, (d) => renderCustomFieldsEnumAddHuman(d));
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
 *
 * - 400 mentioning "value" → "--value must be a non-empty string."
 * - 400 generic            → server-side validation hint (covers "non-enum field" rejection per yaml :4375).
 * - 403                     → permission hint (caller is not a project commander).
 * - 404                     → field-not-found hint.
 */
function rewriteApiHint(err: unknown): unknown {
  if (!(err instanceof FreeloApiError)) return err;
  if (err.httpStatus === 400) {
    const haystack = [err.message, ...err.errors].join(' ');
    const hintNext = /\bvalue\b/i.test(haystack)
      ? '--value must be a non-empty string.'
      : 'Server-side validation rejected the request; the target field may not be enum-typed.';
    return rebrand(err, hintNext);
  }
  if (err.httpStatus === 403) {
    return rebrand(err, "Account is not a project commander on the field's project.");
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
