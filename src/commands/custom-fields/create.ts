/**
 * `freelo custom-fields create --project <id> --name <str> --type <type-uuid> [--uuid <uuid>] [--dry-run]`
 * (R41, spec 0055).
 *
 * Creates a custom-field definition on a project. Wire:
 * `POST /custom-field/create/{project_id}` (yaml :4043-4095).
 *
 * Non-destructive (creates new state). Single-shot — no batch input.
 *
 * The CLI does NOT pre-validate that `--type <uuid>` is one of the three
 * documented type uuids — server-side enforces it (404 / 400 with hint).
 * The catalog might grow; gating on a stale list defeats the purpose.
 *
 * Output schema: `freelo.custom-fields.create/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  buildCreateCustomFieldBody,
  createCustomField,
  createCustomFieldPath,
  type CreateCustomFieldInput,
} from '../../api/custom-fields.js';
import { type CustomFieldsCreateData } from '../../api/schemas/custom-field.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { render } from '../../ui/render.js';
import { renderCustomFieldsCreateHuman } from '../../ui/human/custom-fields-create.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.custom-fields.create/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.custom-fields.create/v1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CreateOpts = {
  project?: number;
  name?: string;
  type?: string;
  uuid?: string;
  dryRun?: true;
};

/* ---------------------------------------------------------------------------
 *  Flag parsers — each throws ValidationError (BaseError, exit 2). NOT
 *  Commander's InvalidArgumentError, which falls through to exit 1
 *  (Calibration §1-2).
 * ------------------------------------------------------------------------- */

function parseProjectFlag(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('--project must be a positive integer.', {
      hintNext:
        '--project is the numeric project id from `freelo projects list`. Required for `custom-fields create`.',
    });
  }
  return n;
}

function parseTypeFlag(raw: string): string {
  if (!UUID_RE.test(raw)) {
    throw new ValidationError('--type must be a UUID.', {
      hintNext:
        '--type is the uuid of one of the type rows from `freelo custom-fields types` (text / number / enum).',
    });
  }
  return raw;
}

function parseUuidFlag(raw: string): string {
  if (!UUID_RE.test(raw)) {
    throw new ValidationError('--uuid must be a UUID.', {
      hintNext:
        '--uuid is optional; pass a v4 UUID to assign a deterministic id (useful for reproducible provisioning).',
    });
  }
  return raw;
}

export function registerCreate(
  customFields: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = customFields
    .command('create')
    .description(
      'Create a custom-field definition on a project. Caller must be a project commander. The --type uuid comes from `freelo custom-fields types`.',
    )
    .option('--project <id>', 'Project id (required, positive integer).', parseProjectFlag)
    .option('--name <str>', 'Display name for the new custom field (required, non-empty).')
    .option(
      '--type <uuid>',
      'UUID of the type from `freelo custom-fields types` (required).',
      parseTypeFlag,
    )
    .option(
      '--uuid <uuid>',
      'Optional pre-assigned UUID for the new field (deterministic provisioning).',
      parseUuidFlag,
    )
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (opts: CreateOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      validateFlags(opts);
      await runCreate(opts, appConfig, env);
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/* ---------------------------------------------------------------------------
 *  Required-flag validation. Format-level checks live in the parser
 *  callbacks above; presence checks live here.
 * ------------------------------------------------------------------------- */

function validateFlags(opts: CreateOpts): void {
  if (opts.project === undefined) {
    throw new ValidationError('--project is required.', {
      hintNext: '--project <id> where <id> is the numeric project id.',
    });
  }
  if (opts.name === undefined || opts.name.trim().length === 0) {
    throw new ValidationError('--name is required and must be non-empty.', {
      hintNext: '--name is the display name for the new custom field.',
    });
  }
  if (opts.type === undefined) {
    throw new ValidationError('--type is required.', {
      hintNext: '--type is the type uuid from `freelo custom-fields types`.',
    });
  }
}

/* ---------------------------------------------------------------------------
 *  Live + dry-run dispatch
 * ------------------------------------------------------------------------- */

async function runCreate(
  opts: CreateOpts,
  appConfig: PartialAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const mode = appConfig.output.mode;
  const projectId = opts.project!;
  const input: CreateCustomFieldInput = {
    name: opts.name!.trim(),
    typeUuid: opts.type!,
  };
  if (opts.uuid !== undefined) input.uuid = opts.uuid;
  const body = buildCreateCustomFieldBody(input);

  // ---- Dry-run.
  if (opts.dryRun === true) {
    const dryData: Pick<CustomFieldsCreateData, 'project_id'> = { project_id: projectId };
    const envelope = dryRunEnvelope({
      schema: SCHEMA,
      data: dryData,
      would: { method: 'POST', path: createCustomFieldPath(projectId), body },
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
    render(mode, envelope, (d) => renderCustomFieldsCreateHuman(d));
    return;
  }

  // ---- Live POST.
  const client = await buildClient(appConfig, env);
  let result: Awaited<ReturnType<typeof createCustomField>>;
  try {
    result = await createCustomField(client, projectId, {
      body,
      ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
    });
  } catch (err: unknown) {
    throw rewriteApiHint(err);
  }

  const data: CustomFieldsCreateData = {
    project_id: projectId,
    custom_field: result.body.custom_field,
  };
  const envelope: Envelope<CustomFieldsCreateData> = buildEnvelope({
    schema: SCHEMA,
    data,
    rateLimit: {
      remaining: result.raw.rateLimit.remaining,
      reset_at: result.raw.rateLimit.resetAt,
    },
    ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
  });
  render(mode, envelope, (d) => renderCustomFieldsCreateHuman(d));
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
 * Map `FreeloApiError` thrown by `createCustomField` to friendlier `hintNext`
 * messages for the well-known cases. Returns the original error unchanged
 * for non-FreeloApiError values and statuses we do not specialize.
 *
 * Per spec 0055 §2.5:
 *   - 400 mentioning `name`  → name-rejection hint.
 *   - 400 mentioning `type`  → type-uuid hint pointing at `custom-fields types`.
 *   - 400 mentioning `uuid`  → uuid-conflict hint.
 *   - 400 generic            → server-side validation hint.
 *   - 402 / PlanExceeded     → plan-limit hint.
 *   - 403                    → project-commander permission hint.
 *   - 404                    → project-not-found / type-not-in-catalog hint.
 */
function rewriteApiHint(err: unknown): unknown {
  if (!(err instanceof FreeloApiError)) return err;
  const haystack = [err.message, ...err.errors].join(' ');

  if (err.httpStatus === 400) {
    let hintNext: string;
    if (/\bname\b/i.test(haystack)) {
      hintNext = "Server rejected --name; check it's non-empty and unique on the project.";
    } else if (/\btype\b/i.test(haystack)) {
      hintNext = 'Server rejected --type; pass a uuid from `freelo custom-fields types`.';
    } else if (/\buuid\b/i.test(haystack)) {
      hintNext = 'Server rejected --uuid; must be a v4 UUID, unused on this project.';
    } else {
      hintNext = 'Server-side validation rejected the request; review the message.';
    }
    return rebrand(err, hintNext);
  }
  if (err.httpStatus === 402 || /PlanExceeded/i.test(haystack)) {
    return rebrand(err, 'Plan limit reached — check the Freelo subscription tier.');
  }
  if (err.httpStatus === 403) {
    return rebrand(
      err,
      'Account is not a project commander on the target project — required to create custom fields.',
    );
  }
  if (err.httpStatus === 404) {
    return rebrand(
      err,
      'Project not found, OR --type uuid is not in the catalog. Run `freelo projects list` and `freelo custom-fields types` to verify.',
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
