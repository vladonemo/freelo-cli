import { generateRequestId, parseRequestId } from '../lib/request-id.js';
import { resolveOutputMode } from '../lib/env.js';
import { readStore } from './store.js';
import { type PartialAppConfig, type ProfileSource } from './schema.js';
import { VERSION } from '../lib/version.js';

const API_BASE_DEFAULT = 'https://api.freelo.io/v1';
const USER_AGENT = `freelo-cli/${VERSION} (+https://github.com/magic-soft/freelo-cli)`;

export type BuildAppConfigFlags = {
  output?: string;
  color?: string;
  profile?: string;
  verbose?: number;
  requestId?: string;
  yes?: boolean;
};

export type BuildAppConfigInput = {
  env: NodeJS.ProcessEnv;
  flags: BuildAppConfigFlags;
};

/**
 * Utility to build a flags object from Commander opts, dropping keys that are
 * `undefined` so `exactOptionalPropertyTypes` is satisfied.
 */
export function pickFlags(
  opts: Record<string, string | number | boolean | undefined>,
): BuildAppConfigFlags {
  const result: BuildAppConfigFlags = {};
  if (typeof opts['output'] === 'string') result.output = opts['output'];
  if (typeof opts['color'] === 'string') result.color = opts['color'];
  if (typeof opts['profile'] === 'string') result.profile = opts['profile'];
  if (typeof opts['verbose'] === 'number') result.verbose = opts['verbose'];
  if (typeof opts['requestId'] === 'string') result.requestId = opts['requestId'];
  if (typeof opts['yes'] === 'boolean') result.yes = opts['yes'];
  return result;
}

/**
 * Assemble the frozen `PartialAppConfig` from flag precedence.
 * Does **not** resolve credentials — callers call `resolveCredentials` after.
 *
 * Precedence (highest first):
 *   CLI flag > env var > user conf > default
 */
export function buildPartialAppConfig(input: BuildAppConfigInput): PartialAppConfig {
  const { env, flags } = input;

  // --- profile ---
  let profile: string;
  let profileSource: ProfileSource;
  if (flags.profile !== undefined && flags.profile !== '') {
    profile = flags.profile;
    profileSource = 'flag';
  } else if (env['FREELO_PROFILE']) {
    profile = env['FREELO_PROFILE'];
    profileSource = 'env';
  } else {
    const store = safeReadStore();
    const confProfile = store?.currentProfile;
    if (confProfile) {
      profile = confProfile;
      profileSource = 'conf';
    } else {
      profile = 'default';
      profileSource = 'default';
    }
  }

  // --- output mode ---
  type OutputModeFlag = 'auto' | 'human' | 'json' | 'ndjson';
  const validOutputModes = new Set<OutputModeFlag>(['auto', 'human', 'json', 'ndjson']);

  let outputMode: OutputModeFlag;
  const rawOutput = flags.output ?? env['FREELO_OUTPUT'];
  if (rawOutput && validOutputModes.has(rawOutput as OutputModeFlag)) {
    outputMode = rawOutput as OutputModeFlag;
  } else {
    outputMode = 'auto';
  }

  // --- color ---
  type ColorMode = 'auto' | 'never' | 'always';
  const validColors = new Set<ColorMode>(['auto', 'never', 'always']);
  let colorMode: ColorMode;
  const rawColor = flags.color ?? env['FREELO_COLOR'];
  if (rawColor && validColors.has(rawColor as ColorMode)) {
    colorMode = rawColor as ColorMode;
  } else {
    colorMode = 'auto';
  }

  // --- verbose ---
  let verbose: 0 | 1 | 2;
  if (env['FREELO_DEBUG'] === '1') {
    verbose = 2;
  } else if (typeof flags.verbose === 'number') {
    verbose = flags.verbose >= 2 ? 2 : flags.verbose === 1 ? 1 : 0;
  } else {
    verbose = 0;
  }

  // --- request ID ---
  let requestId: string;
  if (flags.requestId) {
    requestId = parseRequestId(flags.requestId);
  } else {
    requestId = generateRequestId();
  }

  // --- yes ---
  const yes = flags.yes ?? false;

  // --- apiBaseUrl (from env override) ---
  const apiBaseUrl = env['FREELO_API_BASE'] ?? API_BASE_DEFAULT;

  // Resolve output now so commands don't have to.
  const resolvedMode = resolveOutputMode(outputMode);

  return Object.freeze({
    profile,
    profileSource,
    apiBaseUrl,
    userAgent: USER_AGENT,
    output: { mode: resolvedMode, color: colorMode },
    verbose,
    yes,
    requestId,
  });
}

function safeReadStore() {
  try {
    return readStore();
  } catch {
    return undefined;
  }
}
