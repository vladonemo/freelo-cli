/**
 * `freelo task-labels colors` (M05, spec 0067).
 *
 * Lists the task-label palette the **server** accepts, and reports whether the
 * CLI's local `--palette` table still matches it.
 *
 * Maps to **`GET /task-label-colors`** (yaml :2878-2896) — a top-level path,
 * not a child of `/task-labels`. No parameters, no pagination.
 *
 * Read-only: no `--dry-run` (nothing to preview), no confirmation gate, no
 * flags of its own.
 *
 * **This command does not change how `--palette` works.** The local `PALETTE`
 * in `src/lib/label-color.ts` remains the sole validator for `--palette` on
 * every command that accepts a color: it is offline, free, deterministic, and
 * a color the server accepts but the CLI has no name for is already reachable
 * with `--hex`. The server's `display_name` is documented as display-only and
 * not accepted as input, so there is no server-side name vocabulary to adopt
 * even if we wanted one. Spec 0067 §6 / decision 02.
 *
 * **Drift is data, not an error.** Exit is 0 whether or not the tables agree;
 * a consumer that wants to fail a build reads `.data.drift.matches`.
 *
 * Output schema: `freelo.task_labels.colors/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient } from '../../api/client.js';
import { getTaskLabelColors } from '../../api/task-labels.js';
import {
  type TaskLabelsColorsData,
  type TaskLabelsColorsEntry,
} from '../../api/schemas/task-label.js';
import { comparePaletteToServer, paletteNameForHex } from '../../lib/label-color.js';
import { buildEnvelope, type SchemaString } from '../../ui/envelope.js';
import { renderAsync } from '../../ui/render.js';
import { renderTaskLabelsColorsHuman } from '../../ui/human/task-labels-colors.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.task_labels.colors/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.task_labels.colors/v1';

export function registerColors(
  parent: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = parent
    .command('colors')
    .description(
      'List the task-label color palette the Freelo server accepts, and flag any drift from the local `--palette` name table. Read-only, takes no arguments. Each row carries the hex to send, the local `--palette` name for it (if any), the display name Freelo uses, and whether it is the default applied when a label is created without a color. Drift is reported as data, not an error: the command exits 0 either way, so a scheduled check reads `.data.drift.matches`.',
    );
  attachMeta(cmd, meta);

  cmd.action(async () => {
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

      const result = await getTaskLabelColors(client, {
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });

      const colors: TaskLabelsColorsEntry[] = result.colors.map((c) => ({
        ...c,
        palette_name: paletteNameForHex(c.color),
      }));

      // First `is_default` wins. The contract implies exactly one, but it does
      // not constrain the count, and a stable pick beats an arbitrary one.
      const defaultEntry = result.colors.find((c) => c.is_default === true);
      const comparison = comparePaletteToServer(result.colors.map((c) => c.color));

      const data: TaskLabelsColorsData = {
        colors,
        count: colors.length,
        default_color: defaultEntry?.color ?? null,
        drift: {
          matches: comparison.matches,
          server_only: comparison.serverOnly,
          local_only: comparison.localOnly,
        },
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
      await renderAsync(mode, envelope, (d) => renderTaskLabelsColorsHuman(d));
    } catch (err: unknown) {
      await handleTopLevelError(err, mode);
    }
  });
}
