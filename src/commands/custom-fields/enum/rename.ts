/**
 * `freelo custom-fields enum rename <enum_uuid> --value <str> [--dry-run]`
 * (R43, spec 0057).
 *
 * Renames the display value of an existing enum option. Wire:
 * `POST /custom-field-enum/change/{custom_field_enum_uuid}` (yaml :4416-4464).
 * Verb is POST per OpenAPI — the roadmap entry's PATCH is wrong (decision 1).
 *
 * Single-shot, non-destructive. Only `--value` mutates; uuid is preserved.
 *
 * Not idempotent — rename of a deleted option is a real failure (404 → bubble).
 *
 * Output schema: `freelo.custom-fields.enum-rename/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../../config/schema.js';
import { resolveCredentials } from '../../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../../api/client.js';
import { changeCustomFieldEnum, changeCustomFieldEnumPath } from '../../../api/custom-fields.js';
import { type CustomFieldsEnumRenameData } from '../../../api/schemas/custom-field.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../../ui/envelope.js';
import { dryRunEnvelope } from '../../../lib/dry-run.js';
import { render } from '../../../ui/render.js';
import { renderCustomFieldsEnumRenameHuman } from '../../../ui/human/custom-fields-enum-rename.js';
import { handleTopLevelError } from '../../../errors/handle.js';
import { ValidationError } from '../../../errors/validation-error.js';
import { FreeloApiError } from '../../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.custom-fields.enum-rename/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.custom-fields.enum-rename/v1';

type RenameOpts = {
  value?: string;
  dryRun?: true;
};

function parseUuidArg(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('<enum_uuid> must be a non-empty uuid.', {
      hintNext:
        '<enum_uuid> is the enum-option uuid from `freelo custom-fields enum list --field <uuid>`.',
    });
  }
  return trimmed;
}

export function registerEnumRename(
  enumCmd: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = enumCmd
    .command('rename')
    .description(
      "Rename the display value of an enum option. The option's uuid is preserved, so existing task values referencing it continue to work. Caller must be a project commander on the field's project.",
    )
    .argument(
      '<enum_uuid>',
      'Enum-option uuid from `freelo custom-fields enum list --field <uuid>`.',
      parseUuidArg,
    )
    .option('--value <str>', 'New display value (required, non-empty).')
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (uuid: string, opts: RenameOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      if (opts.value === undefined || opts.value.trim().length === 0) {
        throw new ValidationError('--value is required and must be non-empty.', {
          hintNext: '`custom-fields enum rename <enum_uuid> --value "New label"`.',
        });
      }
      await runRename(uuid, opts.value.trim(), opts.dryRun === true, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

async function runRename(
  uuid: string,
  newValue: string,
  isDryRun: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const body = { value: newValue };

  if (isDryRun) {
    const dryData: Pick<CustomFieldsEnumRenameData, 'uuid' | 'applied_changes'> = {
      uuid,
      applied_changes: { value: newValue },
    };
    const envelope = dryRunEnvelope({
      schema: SCHEMA,
      data: dryData,
      would: { method: 'POST', path: changeCustomFieldEnumPath(uuid), body },
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    render(mode, envelope, (d) => renderCustomFieldsEnumRenameHuman(d));
    return;
  }

  const client = await buildClient(appConfig, env);
  let result: Awaited<ReturnType<typeof changeCustomFieldEnum>>;
  try {
    result = await changeCustomFieldEnum(client, uuid, {
      body,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    throw rewriteApiHint(err);
  }

  const data: CustomFieldsEnumRenameData = {
    uuid,
    applied_changes: { value: newValue },
  };
  // Read the validated body so the schema is exercised; the CLI doesn't
  // surface the full server-side option back (the input is the authoritative
  // new value).
  void result.body.custom_field_enum;
  const envelope: Envelope<CustomFieldsEnumRenameData> = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: result.raw.rateLimit.remaining,
      reset_at: result.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  render(mode, envelope, (d) => renderCustomFieldsEnumRenameHuman(d));
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
 * - 400 → server-side validation hint.
 * - 403 → permission hint.
 * - 404 → option-not-found hint. **Not idempotent** — bubbles.
 */
function rewriteApiHint(err: unknown): unknown {
  if (!(err instanceof FreeloApiError)) return err;
  if (err.httpStatus === 400) {
    return rebrand(err, 'Server-side validation rejected the request; review the message.');
  }
  if (err.httpStatus === 403) {
    return rebrand(err, "Account is not a project commander on the field's project.");
  }
  if (err.httpStatus === 404) {
    return rebrand(
      err,
      'Enum option not found. Run `freelo custom-fields enum list --field <uuid>` for uuids.',
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
