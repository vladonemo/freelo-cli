/**
 * `freelo custom-fields rename <uuid> --name <str> [--dry-run]` (R41, spec 0055).
 *
 * Renames an existing custom-field definition. Wire:
 * `POST /custom-field/rename/{uuid}` (yaml :4097-4136). Verb is POST per
 * OpenAPI — the roadmap entry's PATCH is wrong (decision 1).
 *
 * Single-shot, non-destructive. Only `--name` mutates; uuid + type are
 * immutable via this endpoint (yaml :4106-4107).
 *
 * Output schema: `freelo.custom-fields.rename/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { renameCustomField, renameCustomFieldPath } from '../../api/custom-fields.js';
import { type CustomFieldsRenameData } from '../../api/schemas/custom-field.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { render } from '../../ui/render.js';
import { renderCustomFieldsRenameHuman } from '../../ui/human/custom-fields-rename.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.custom-fields.rename/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.custom-fields.rename/v1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RenameOpts = {
  name?: string;
  dryRun?: true;
};

function parseUuidArg(raw: string): string {
  if (!UUID_RE.test(raw)) {
    throw new ValidationError('<uuid> must be a UUID.', {
      hintNext: '<uuid> is the custom-field uuid from `freelo custom-fields list --project <id>`.',
    });
  }
  return raw;
}

export function registerRename(
  customFields: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = customFields
    .command('rename')
    .description(
      "Rename a custom-field definition. Only `name` is mutable via this endpoint; uuid + type are immutable. Caller must be a project commander of the field's project.",
    )
    .argument(
      '<uuid>',
      'Custom-field uuid from `freelo custom-fields list --project <id>`.',
      parseUuidArg,
    )
    .option('--name <str>', 'New display name (required, non-empty).')
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (uuid: string, opts: RenameOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      if (opts.name === undefined || opts.name.trim().length === 0) {
        throw new ValidationError('--name is required and must be non-empty.', {
          hintNext: '`custom-fields rename <uuid> --name "New name"`.',
        });
      }
      await runRename(uuid, opts.name.trim(), opts.dryRun === true, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

async function runRename(
  uuid: string,
  newName: string,
  isDryRun: boolean,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const body = { name: newName };

  if (isDryRun) {
    const dryData: Pick<CustomFieldsRenameData, 'uuid' | 'applied_changes'> = {
      uuid,
      applied_changes: { name: newName },
    };
    const envelope = dryRunEnvelope({
      schema: SCHEMA,
      data: dryData,
      would: { method: 'POST', path: renameCustomFieldPath(uuid), body },
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    render(mode, envelope, (d) => renderCustomFieldsRenameHuman(d));
    return;
  }

  const client = await buildClient(appConfig, env);
  let result: Awaited<ReturnType<typeof renameCustomField>>;
  try {
    result = await renameCustomField(client, uuid, {
      body,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    throw rewriteApiHint(err);
  }

  const data: CustomFieldsRenameData = {
    uuid,
    applied_changes: { name: newName },
  };
  // result.body is read here so the schema validation runs against the
  // server response. The CLI doesn't need to surface the full custom_field
  // back to the caller — the input is the authoritative new name.
  void result.body.custom_field;
  const envelope: Envelope<CustomFieldsRenameData> = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: result.raw.rateLimit.remaining,
      reset_at: result.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  render(mode, envelope, (d) => renderCustomFieldsRenameHuman(d));
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
 * Map well-known `FreeloApiError` cases to friendly hints.
 *
 * Per spec 0055 §2.5:
 *   - 400 generic → server-side validation hint.
 *   - 403         → permission hint (caller is not a project commander).
 *   - 404         → field-not-found hint. NOT idempotent — rename-of-deleted
 *                   is a real failure (decision 6 in spec 0055).
 */
function rewriteApiHint(err: unknown): unknown {
  if (!(err instanceof FreeloApiError)) return err;
  if (err.httpStatus === 400) {
    return rebrand(err, 'Server-side validation rejected the request; review the message.');
  }
  if (err.httpStatus === 403) {
    return rebrand(err, "Account is not a project commander of the field's project.");
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
