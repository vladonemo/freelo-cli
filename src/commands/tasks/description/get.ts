/**
 * `freelo tasks description get <id>` (R15, spec 0026).
 *
 * Reads the task's rich-text description (the first "pinned" comment that
 * serves as the canonical body). Reuses the existing `getTaskDescription`
 * wire wrapper from R08 (`src/api/tasks.ts:187`).
 *
 * Output schema: `freelo.tasks.description.get/v1`.
 *
 * Spec 0026 §3.2.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../../config/schema.js';
import { resolveCredentials } from '../../../config/credentials.js';
import { createHttpClient } from '../../../api/client.js';
import { getTaskDescription } from '../../../api/tasks.js';
import { type TasksDescriptionGetData } from '../../../api/schemas/task-description.js';
import { buildEnvelope, type SchemaString } from '../../../ui/envelope.js';
import { render } from '../../../ui/render.js';
import { renderTasksDescriptionGetHuman } from '../../../ui/human/tasks-description-get.js';
import { handleTopLevelError } from '../../../errors/handle.js';
import { ValidationError } from '../../../errors/validation-error.js';
import { FreeloApiError } from '../../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.description.get/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.tasks.description.get/v1';

/**
 * Parse the `<id>` positional. Throws `ValidationError` (BaseError, exit 2)
 * — NOT Commander's `InvalidArgumentError` which would map to exit 1
 * (calibration §1-2).
 */
function parseTaskId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('<id> must be a positive integer.', {
      hintNext: '<id> is the numeric task id from `freelo tasks list`.',
    });
  }
  return n;
}

export function registerDescriptionGet(
  description: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = description
    .command('get')
    .description("Print one task's rich-text description.")
    .argument('<id>', 'Task id (positive integer).', parseTaskId);
  attachMeta(cmd, meta);

  cmd.action(async (id: number) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      const creds = await resolveCredentials({
        profile: appConfig.profile,
        apiBaseUrl: appConfig.apiBaseUrl,
        env,
      });
      const client = createHttpClient({
        email: creds.email,
        apiKey: creds.apiKey,
        apiBaseUrl: creds.apiBaseUrl,
        userAgent: appConfig.userAgent,
      });

      let result: Awaited<ReturnType<typeof getTaskDescription>>;
      try {
        result = await getTaskDescription(client, id, {
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
      } catch (err: unknown) {
        throw rewriteGetHint(err, id);
      }

      const data: TasksDescriptionGetData = {
        task_id: id,
        description: result.data,
      };
      const envelope = buildEnvelope({
        schema: SCHEMA,
        data,
        rateLimit: {
          remaining: result.rateLimit.remaining,
          reset_at: result.rateLimit.resetAt,
        },
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      render(mode, envelope, (d) => renderTasksDescriptionGetHuman(d));
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/**
 * Hint rewriter for `getTaskDescription` failures. Mirrors the pattern in
 * `src/commands/tasks/show.ts:rewriteDescriptionHint`. 404 / 403 get
 * resource-specific copy; other statuses pass through unchanged.
 */
function rewriteGetHint(err: unknown, taskId: number): unknown {
  if (!(err instanceof FreeloApiError) || (err.httpStatus !== 404 && err.httpStatus !== 403)) {
    return err;
  }
  const hintNext =
    err.httpStatus === 404
      ? `Description for task ${taskId} not found, or your account does not have access.`
      : `Account does not have permission to view description for task ${taskId}.`;
  return new FreeloApiError(err.message, err.code, {
    httpStatus: err.httpStatus,
    errors: err.errors,
    rawBody: err.rawBody,
    hintNext,
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
  });
}
