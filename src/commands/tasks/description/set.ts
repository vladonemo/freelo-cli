/**
 * `freelo tasks description set <id> (--from-file <path> | --editor | -)`
 * (R15, spec 0026).
 *
 * Replaces the task's rich-text description (upsert — first call creates,
 * subsequent calls overwrite, no history). Content comes from one of three
 * sources, mediated by the shared `src/lib/input.ts` helper:
 *
 *   - `--from-file <path>` — read UTF-8 file.
 *   - `--editor`           — spawn $VISUAL/$EDITOR (TTY-only).
 *   - `-`                  — read stdin to EOF.
 *
 * Empty content is rejected at the command layer (spec 0026 §5.7) — to clear
 * a description, use R10's `tasks edit <id> --description ''` instead.
 *
 * Output schema: `freelo.tasks.description.set/v1`.
 *
 * Spec 0026 §3.3.
 */

import { Buffer } from 'node:buffer';
import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../../config/schema.js';
import { resolveCredentials } from '../../../config/credentials.js';
import { createHttpClient } from '../../../api/client.js';
import {
  buildSetDescriptionBody,
  setDescriptionPath,
  setTaskDescription,
  type SetDescriptionResult,
} from '../../../api/tasks-description.js';
import {
  type TasksDescriptionSetData,
  type SetDescriptionInput,
} from '../../../api/schemas/task-description.js';
import { buildEnvelope, type SchemaString } from '../../../ui/envelope.js';
import { dryRunEnvelope } from '../../../lib/dry-run.js';
import { readInput, type InputSource } from '../../../lib/input.js';
import { render } from '../../../ui/render.js';
import { renderTasksDescriptionSetHuman } from '../../../ui/human/tasks-description-set.js';
import { handleTopLevelError } from '../../../errors/handle.js';
import { ValidationError } from '../../../errors/validation-error.js';
import { FreeloApiError } from '../../../errors/freelo-api-error.js';
import { attachMeta, type CommandMeta } from '../../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.description.set/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.tasks.description.set/v1';

type SetOpts = {
  fromFile?: string;
  editor?: boolean;
  dryRun?: boolean;
};

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

/**
 * Parse the optional `<input>` positional. Only legal value is the literal
 * `-` (meaning "read from stdin"). Anything else → `ValidationError`.
 */
function parseStdinSentinel(raw: string): '-' {
  if (raw !== '-') {
    throw new ValidationError(`Unexpected positional '${raw}'.`, {
      hintNext:
        "The only legal positional after <id> is '-' (read from stdin). Use --from-file <path> for a file source.",
    });
  }
  return '-';
}

export function registerDescriptionSet(
  description: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = description
    .command('set')
    .description(
      "Replace one task's rich-text description from a file, an interactive editor, or stdin (upsert).",
    )
    .argument('<id>', 'Task id (positive integer).', parseTaskId)
    .argument(
      '[input]',
      "Input source sentinel: pass '-' to read content from stdin.",
      parseStdinSentinel,
    )
    .option(
      '--from-file <path>',
      'Read description content from a UTF-8 file. Mutex with --editor and `-`.',
    )
    .option(
      '--editor',
      'Open $VISUAL/$EDITOR (or platform default) to edit content interactively. Requires a TTY.',
    )
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.');
  attachMeta(cmd, meta);

  cmd.action(async (id: number, input: '-' | undefined, opts: SetOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      const inputSource = pickInputSource(input, opts);

      // Read content from the chosen source. Errors are typed
      // ValidationError (exit 2) per src/lib/input.ts.
      const { content, source } = await readInput(inputSource, { env });

      // Empty content is rejected at the command layer (spec 0026 §5.7).
      if (content.length === 0) {
        throw new ValidationError('Description content is empty; refusing to overwrite.', {
          hintNext:
            "Pass non-empty content. To clear an existing description, use `freelo tasks edit <id> --description ''`.",
        });
      }

      const inputData: SetDescriptionInput = { content };
      const body = buildSetDescriptionBody(inputData);
      const byteLength = Buffer.byteLength(content, 'utf8');

      // --- Dry-run: no HTTP, no credential resolution.
      if (opts.dryRun === true) {
        const data: TasksDescriptionSetData = {
          task_id: id,
          byte_length: byteLength,
        };
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data,
          would: { method: 'POST', path: setDescriptionPath(id), body },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        render(mode, envelope, (d) => renderTasksDescriptionSetHuman(d));
        return;
      }

      // --- Live POST.
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

      let result: SetDescriptionResult;
      try {
        result = await setTaskDescription(client, {
          taskId: id,
          body,
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
      } catch (err: unknown) {
        throw rewriteSetHint(err, id);
      }

      const data: TasksDescriptionSetData = {
        task_id: id,
        description: result.comment,
        source,
        byte_length: byteLength,
      };
      const envelope = buildEnvelope({
        schema: SCHEMA,
        data,
        rateLimit: {
          remaining: result.raw.rateLimit.remaining,
          reset_at: result.raw.rateLimit.resetAt,
        },
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      render(mode, envelope, (d) => renderTasksDescriptionSetHuman(d));
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}

/**
 * Resolve which source to read from given the user's flag selection. Throws
 * `ValidationError` if zero or more-than-one sources are specified.
 *
 * Spec 0026 §3.3 / §6.
 */
function pickInputSource(input: '-' | undefined, opts: SetOpts): InputSource {
  const hasStdin = input === '-';
  const hasFile = opts.fromFile !== undefined;
  const hasEditor = opts.editor === true;

  const count = (hasStdin ? 1 : 0) + (hasFile ? 1 : 0) + (hasEditor ? 1 : 0);
  if (count === 0) {
    throw new ValidationError(
      'Specify exactly one of --from-file <path>, --editor, or - (stdin).',
      {
        hintNext:
          "Pick a source: --from-file <path> for a file, --editor for an interactive editor, or '-' to read stdin.",
      },
    );
  }
  if (count > 1) {
    throw new ValidationError('Specify exactly one input source, not multiple.', {
      hintNext: "Pick one of --from-file, --editor, or '-' (stdin).",
    });
  }

  if (hasFile) {
    return { kind: 'file', path: opts.fromFile! };
  }
  if (hasEditor) {
    return { kind: 'editor' };
  }
  return { kind: 'stdin' };
}

/**
 * Hint rewriter for `setTaskDescription` failures. Mirrors R14's
 * `rewriteAddHint`: 404 (task missing) and 403 (no access) get
 * resource-specific copy. Other statuses pass through unchanged.
 */
function rewriteSetHint(err: unknown, taskId: number): unknown {
  if (!(err instanceof FreeloApiError) || (err.httpStatus !== 404 && err.httpStatus !== 403)) {
    return err;
  }
  const hintNext =
    err.httpStatus === 404
      ? `Task ${taskId} not found, or your account does not have access to it.`
      : `Account does not have permission to set description for task ${taskId}.`;
  return new FreeloApiError(err.message, err.code, {
    httpStatus: err.httpStatus,
    errors: err.errors,
    rawBody: err.rawBody,
    hintNext,
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
  });
}
