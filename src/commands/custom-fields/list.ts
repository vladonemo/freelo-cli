/**
 * `freelo custom-fields list --project <id>` (R40, spec 0054).
 *
 * Read-only. Returns all custom-field definitions configured on a project,
 * plus an `is_commander` boolean indicating whether the caller can call
 * the R41+ mutation endpoints on that project. Wire:
 * `GET /custom-field/find-by-project/{project_id}` (yaml :4529-4561).
 *
 * Soft-deleted fields are excluded server-side (yaml :4542). Empty
 * `custom_fields: []` is a valid 200.
 *
 * No `--dry-run` — the command is read-only and dry-run on a pure GET is
 * a no-op surprise (spec 0054 decision 5).
 *
 * Output schema: `freelo.custom-fields.list/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import { findCustomFieldsByProject } from '../../api/custom-fields.js';
import { type CustomFieldsListData } from '../../api/schemas/custom-field.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { render } from '../../ui/render.js';
import { renderCustomFieldsListHuman } from '../../ui/human/custom-fields-list.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { FreeloApiError } from '../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.custom-fields.list/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.custom-fields.list/v1';

type ListOpts = {
  project?: number;
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
        '--project is the numeric project id from `freelo projects list`. Required for `custom-fields list`.',
    });
  }
  return n;
}

export function registerList(
  customFields: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = customFields
    .command('list')
    .description(
      "List all custom-field definitions configured on a project, plus the caller's commander status (true = can call create / rename / delete / restore on this project). Soft-deleted fields are excluded by Freelo. Read-only.",
    )
    .option('--project <id>', 'Project id (required, positive integer).', parseProjectFlag);
  attachMeta(cmd, meta);

  cmd.action(async (opts: ListOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // ---- Validation: --project is required.
      if (opts.project === undefined) {
        throw new ValidationError('--project is required.', {
          hintNext:
            'Pass --project <id> where <id> is the numeric project id from `freelo projects list`.',
        });
      }
      const projectId = opts.project;

      const client = await buildClient(appConfig, env);
      let result: Awaited<ReturnType<typeof findCustomFieldsByProject>>;
      try {
        // appConfig.requestId is always defined (auto-generated when not flagged);
        // pass it through unconditionally rather than the dead-branchy spread.
        result = await findCustomFieldsByProject(client, projectId, {
          requestId: appConfig.requestId,
        });
      } catch (err: unknown) {
        throw rewriteApiHint(err);
      }

      const data: CustomFieldsListData = {
        project_id: projectId,
        custom_fields: result.body.custom_fields,
        is_commander: result.body.is_commander,
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
      render(mode, envelope, (d) => renderCustomFieldsListHuman(d));
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
 * Map `FreeloApiError` thrown by `findCustomFieldsByProject` to a friendlier
 * `hintNext` for the well-known cases. Returns the original error unchanged
 * for non-FreeloApiError values and statuses we do not specialize.
 *
 * Specialized cases (per spec 0054 §2.5):
 *   - 400 mentioning `project_id`  → project-not-accessible hint.
 *   - 400 generic                  → server-side validation hint.
 *   - 403                          → permission hint.
 *   - 404                          → project-not-found hint.
 */
function rewriteApiHint(err: unknown): unknown {
  if (!(err instanceof FreeloApiError)) return err;

  if (err.httpStatus === 400) {
    const haystack = [err.message, ...err.errors].join(' ');
    let hintNext: string;
    if (/project_id/i.test(haystack)) {
      hintNext =
        '--project must reference a project the caller can access. Run `freelo projects list` for ids.';
    } else {
      hintNext =
        'Server-side validation rejected the request; review the message and adjust flags.';
    }
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext,
    });
  }
  if (err.httpStatus === 403) {
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: 'Account does not have permission to read custom fields on this project.',
    });
  }
  if (err.httpStatus === 404) {
    return new FreeloApiError(err.message, err.code, {
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      errors: err.errors,
      rawBody: err.rawBody,
      hintNext: 'Project not found. Run `freelo projects list` for ids.',
    });
  }
  return err;
}
