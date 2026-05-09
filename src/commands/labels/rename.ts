/**
 * `freelo labels rename <id> [--name <str>] [--palette <name> | --hex <#RRGGBB>] [--is-private | --is-public] [--dry-run]`
 * (R23, spec 0035; decision 11 — `--hex` instead of spec's `--color` to avoid
 * collision with the root global `--color <mode>` flag. R24.5, spec 0048 —
 * added `--palette <name>` mutex with `--hex`; both resolve to the same wire
 * `color: "#RRGGBB"` field.)
 *
 * Renames / recolors / toggles privacy on an existing project label. At
 * least one of `--name` / `--palette` / `--hex` / `--is-private` / `--is-public` is
 * required (empty edit rejected per decision 04).
 *
 * Maps to **`POST /project-labels/{labelId}`** (verb is POST, not PATCH —
 * spec 0035 decision 01).
 *
 * Output schema: `freelo.labels.rename/v1`.
 */

import { type Command } from 'commander';
import { type GetAppConfig, type PartialAppConfig } from '../../config/schema.js';
import { resolveCredentials } from '../../config/credentials.js';
import { createHttpClient, type HttpClient } from '../../api/client.js';
import {
  buildEditProjectLabelBody,
  editProjectLabel,
  labelPath,
  type EditProjectLabelInput,
} from '../../api/project-labels.js';
import {
  type LabelsRenameAppliedChanges,
  type LabelsRenameDryRunData,
  type LabelsRenameLiveData,
} from '../../api/schemas/project-label.js';
import { buildEnvelope, type Envelope, type SchemaString } from '../../ui/envelope.js';
import { dryRunEnvelope } from '../../lib/dry-run.js';
import { render } from '../../ui/render.js';
import { renderLabelsRenameHuman } from '../../ui/human/labels-rename.js';
import { handleTopLevelError } from '../../errors/handle.js';
import { ValidationError } from '../../errors/validation-error.js';
import { attachMeta, type CommandMeta } from '../../lib/introspect.js';
import { paletteHelpBlock, resolveColorFlags } from '../../lib/label-color.js';

export const meta: CommandMeta = {
  outputSchema: 'freelo.labels.rename/v1',
  destructive: false,
};

const SCHEMA: SchemaString = 'freelo.labels.rename/v1';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

type RenameOpts = {
  name?: string;
  palette?: string;
  hex?: string;
  isPrivate?: boolean;
  isPublic?: boolean;
  dryRun?: boolean;
};

/* ---------------------------------------------------------------------------
 *  Input parsers — typed errors per Calibration §2.
 * ------------------------------------------------------------------------- */

function parseLabelId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('<id> must be a positive integer.', {
      hintNext: '<id> is the numeric label id from `freelo labels list`.',
    });
  }
  return n;
}

function parseHexColorFlag(raw: string): string {
  if (!HEX_COLOR.test(raw)) {
    throw new ValidationError('--hex must match the pattern #RRGGBB (six hex digits).', {
      hintNext: 'Pass a six-digit hex color, e.g. --hex "#9b59b6".',
    });
  }
  return raw;
}

/* ---------------------------------------------------------------------------
 *  Command registration
 * ------------------------------------------------------------------------- */

export function registerRename(
  labels: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const cmd = labels
    .command('rename')
    .description(
      'Rename, recolor, or toggle private/public on an existing project label. At least one change flag is required.',
    )
    .argument('<id>', 'Numeric label id from `freelo labels list`.', parseLabelId)
    .option('--name <str>', 'New label name.')
    .option(
      '--palette <name>',
      'Palette color name (case-insensitive). Mutex with --hex. See list below.',
    )
    .option(
      '--hex <color>',
      'New label color in #RRGGBB format (six hex digits). Mutex with --palette. Named `--hex` (not `--color`) to avoid collision with the global `--color <mode>` output-colorization flag — see decision 11.',
      parseHexColorFlag,
    )
    .option('--is-private', 'Flip the label to private (mutex with --is-public).')
    .option('--is-public', 'Flip the label to public (mutex with --is-private).')
    .option('--dry-run', 'Skip the POST; envelope echoes the body that would have been sent.')
    .addHelpText('after', paletteHelpBlock());
  attachMeta(cmd, meta);

  cmd.action(async (id: number, opts: RenameOpts) => {
    const appConfig: PartialAppConfig = getConfig();
    const mode = appConfig.output.mode;

    try {
      // Mutex: --is-private vs --is-public
      if (opts.isPrivate === true && opts.isPublic === true) {
        throw new ValidationError('--is-private and --is-public are mutually exclusive.', {
          hintNext: 'Pick one: --is-private OR --is-public.',
        });
      }

      // Resolve --palette / --hex (mutex + lookup happen here).
      const color = resolveColorFlags({ palette: opts.palette, hex: opts.hex });

      // Empty-edit rejection (decision 04).
      const hasNoChange =
        opts.name === undefined &&
        color === undefined &&
        opts.isPrivate !== true &&
        opts.isPublic !== true;
      if (hasNoChange) {
        throw new ValidationError(
          '`labels rename` requires at least one of --name, --palette, --hex, --is-private, or --is-public.',
          {
            hintNext:
              'Pass at least one change flag, e.g. `freelo labels rename 12 --name "Billable"`.',
          },
        );
      }

      const isPrivate: boolean | undefined =
        opts.isPrivate === true ? true : opts.isPublic === true ? false : undefined;

      const apiInput: EditProjectLabelInput = {
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(isPrivate !== undefined ? { isPrivate } : {}),
      };
      const body = buildEditProjectLabelBody(apiInput);

      const appliedChanges: LabelsRenameAppliedChanges = {};
      if (opts.name !== undefined) appliedChanges.name = opts.name;
      if (color !== undefined) appliedChanges.color = color;
      if (isPrivate !== undefined) appliedChanges.is_private = isPrivate;

      // ---- Dry-run.
      if (opts.dryRun === true) {
        const dryData: LabelsRenameDryRunData = {
          label_id: id,
          applied_changes: appliedChanges,
        };
        const envelope = dryRunEnvelope({
          schema: SCHEMA,
          data: dryData,
          would: { method: 'POST', path: labelPath(id), body },
          ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
        });
        render(mode, envelope, (d) => renderLabelsRenameHuman(d));
        return;
      }

      // ---- Live POST.
      const client = await buildClient(appConfig, env);
      const result = await editProjectLabel(client, id, {
        body,
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });

      const data: LabelsRenameLiveData = {
        label_id: id,
        applied_changes: appliedChanges,
      };
      const envelope: Envelope<LabelsRenameLiveData> = buildEnvelope({
        schema: SCHEMA,
        data,
        rateLimit: {
          remaining: result.raw.rateLimit.remaining,
          reset_at: result.raw.rateLimit.resetAt,
        },
        ...(appConfig.requestId !== undefined ? { requestId: appConfig.requestId } : {}),
      });
      render(mode, envelope, (d) => renderLabelsRenameHuman(d));
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
