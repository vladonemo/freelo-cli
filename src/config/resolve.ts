import { generateRequestId, parseRequestId } from '../lib/request-id.js';
import { resolveOutputMode } from '../lib/env.js';
import { readStore } from './store.js';
import { type PartialAppConfig, type ProfileSource } from './schema.js';
import { type RcConfig } from './rc-schema.js';
import { VERSION } from '../lib/version.js';

export const API_BASE_DEFAULT = 'https://api.freelo.io/v1';
const USER_AGENT = `freelo-cli/${VERSION} (+https://github.com/vladonemo/freelo-cli)`;

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
  /** Optional rc layer — slotted between env and conf. */
  rc?: RcConfig;
};

/**
 * Source map: tracks where each field of PartialAppConfig came from.
 * Returned by `buildSourceMap` for `config resolve --show-source`.
 */
export type SourceMap = {
  profile: ProfileSource;
  output: { mode: ProfileSource; color: ProfileSource };
  verbose: ProfileSource;
  apiBaseUrl: ProfileSource;
  requestId: ProfileSource;
  yes: ProfileSource;
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
 *   CLI flag > env var > rc (project .freelorc.*) > user conf > default
 */
export function buildPartialAppConfig(input: BuildAppConfigInput): PartialAppConfig {
  const { env, flags, rc } = input;

  // --- profile ---
  let profile: string;
  let profileSource: ProfileSource;
  if (flags.profile !== undefined && flags.profile !== '') {
    profile = flags.profile;
    profileSource = 'flag';
  } else if (env['FREELO_PROFILE']) {
    profile = env['FREELO_PROFILE'];
    profileSource = 'env';
  } else if (rc?.profile) {
    profile = rc.profile;
    profileSource = 'rc';
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
  const rawOutputFlag = flags.output;
  const rawOutputEnv = env['FREELO_OUTPUT'];
  if (rawOutputFlag && validOutputModes.has(rawOutputFlag as OutputModeFlag)) {
    outputMode = rawOutputFlag as OutputModeFlag;
  } else if (rawOutputEnv && validOutputModes.has(rawOutputEnv as OutputModeFlag)) {
    outputMode = rawOutputEnv as OutputModeFlag;
  } else if (rc?.output && validOutputModes.has(rc.output as OutputModeFlag)) {
    outputMode = rc.output as OutputModeFlag;
  } else {
    // Check conf store defaults
    const store = safeReadStore();
    const confOutput = store?.defaults?.output;
    if (confOutput && validOutputModes.has(confOutput as OutputModeFlag)) {
      outputMode = confOutput as OutputModeFlag;
    } else {
      outputMode = 'auto';
    }
  }

  // --- color ---
  type ColorMode = 'auto' | 'never' | 'always';
  const validColors = new Set<ColorMode>(['auto', 'never', 'always']);
  let colorMode: ColorMode;
  const rawColorFlag = flags.color;
  const rawColorEnv = env['FREELO_COLOR'];
  if (rawColorFlag && validColors.has(rawColorFlag as ColorMode)) {
    colorMode = rawColorFlag as ColorMode;
  } else if (rawColorEnv && validColors.has(rawColorEnv as ColorMode)) {
    colorMode = rawColorEnv as ColorMode;
  } else if (rc?.color && validColors.has(rc.color as ColorMode)) {
    colorMode = rc.color as ColorMode;
  } else {
    // Check conf store defaults
    const store = safeReadStore();
    const confColor = store?.defaults?.color;
    if (confColor && validColors.has(confColor as ColorMode)) {
      colorMode = confColor as ColorMode;
    } else {
      colorMode = 'auto';
    }
  }

  // --- verbose ---
  let verbose: 0 | 1 | 2;
  if (env['FREELO_DEBUG'] === '1') {
    verbose = 2;
  } else if (typeof flags.verbose === 'number') {
    verbose = flags.verbose >= 2 ? 2 : flags.verbose === 1 ? 1 : 0;
  } else if (rc?.verbose !== undefined) {
    verbose = rc.verbose;
  } else {
    const store = safeReadStore();
    const confVerbose = store?.defaults?.verbose;
    verbose = confVerbose ?? 0;
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

  // --- apiBaseUrl ---
  // Precedence: env > rc > active profile conf > default
  let apiBaseUrl: string;
  if (env['FREELO_API_BASE']) {
    apiBaseUrl = env['FREELO_API_BASE'];
  } else if (rc?.apiBaseUrl) {
    apiBaseUrl = rc.apiBaseUrl;
  } else {
    // Check per-profile conf (need the resolved profile name to look it up)
    const store = safeReadStore();
    const profileConf = store?.profiles[profile];
    if (profileConf?.apiBaseUrl) {
      apiBaseUrl = profileConf.apiBaseUrl;
    } else {
      apiBaseUrl = API_BASE_DEFAULT;
    }
  }

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

/**
 * Build a source map that tracks where each field of `PartialAppConfig` came
 * from. Used by `config resolve --show-source` to emit per-leaf source
 * annotations without re-deriving the full precedence chain.
 *
 * This function mirrors the logic in `buildPartialAppConfig` but only assigns
 * source labels, not values.
 */
export function buildSourceMap(input: BuildAppConfigInput): SourceMap {
  const { env, flags, rc } = input;

  // --- profile source ---
  let profileSource: ProfileSource;
  if (flags.profile !== undefined && flags.profile !== '') {
    profileSource = 'flag';
  } else if (env['FREELO_PROFILE']) {
    profileSource = 'env';
  } else if (rc?.profile) {
    profileSource = 'rc';
  } else {
    const store = safeReadStore();
    profileSource = store?.currentProfile ? 'conf' : 'default';
  }

  // --- output mode source ---
  type OutputModeFlag = 'auto' | 'human' | 'json' | 'ndjson';
  const validOutputModes = new Set<OutputModeFlag>(['auto', 'human', 'json', 'ndjson']);
  let outputModeSource: ProfileSource;
  if (flags.output && validOutputModes.has(flags.output as OutputModeFlag)) {
    outputModeSource = 'flag';
  } else if (env['FREELO_OUTPUT'] && validOutputModes.has(env['FREELO_OUTPUT'] as OutputModeFlag)) {
    outputModeSource = 'env';
  } else if (rc?.output) {
    outputModeSource = 'rc';
  } else {
    const store = safeReadStore();
    outputModeSource = store?.defaults?.output ? 'conf' : 'default';
  }

  // --- color source ---
  type ColorMode = 'auto' | 'never' | 'always';
  const validColors = new Set<ColorMode>(['auto', 'never', 'always']);
  let colorSource: ProfileSource;
  if (flags.color && validColors.has(flags.color as ColorMode)) {
    colorSource = 'flag';
  } else if (env['FREELO_COLOR'] && validColors.has(env['FREELO_COLOR'] as ColorMode)) {
    colorSource = 'env';
  } else if (rc?.color) {
    colorSource = 'rc';
  } else {
    const store = safeReadStore();
    colorSource = store?.defaults?.color ? 'conf' : 'default';
  }

  // --- verbose source ---
  let verboseSource: ProfileSource;
  if (env['FREELO_DEBUG'] === '1') {
    verboseSource = 'env';
  } else if (typeof flags.verbose === 'number') {
    verboseSource = 'flag';
  } else if (rc?.verbose !== undefined) {
    verboseSource = 'rc';
  } else {
    const store = safeReadStore();
    verboseSource = store?.defaults?.verbose !== undefined ? 'conf' : 'default';
  }

  // --- apiBaseUrl source ---
  let apiBaseUrlSource: ProfileSource;
  if (env['FREELO_API_BASE']) {
    apiBaseUrlSource = 'env';
  } else if (rc?.apiBaseUrl) {
    apiBaseUrlSource = 'rc';
  } else {
    const store = safeReadStore();
    // Need profile to check per-profile conf
    let profile = 'default';
    if (flags.profile) {
      profile = flags.profile;
    } else if (env['FREELO_PROFILE']) {
      profile = env['FREELO_PROFILE'];
    } else if (rc?.profile) {
      profile = rc.profile;
    } else if (store?.currentProfile) {
      profile = store.currentProfile;
    }
    apiBaseUrlSource = store?.profiles[profile]?.apiBaseUrl ? 'conf' : 'default';
  }

  // --- requestId source ---
  // When provided by a flag the source is 'flag'. When the ID is freshly minted
  // at runtime (the common case) it is 'generated' — distinct from 'default'
  // which implies a static fallback from a configuration layer.
  const requestIdSource: ProfileSource = flags.requestId ? 'flag' : 'generated';

  // --- yes source ---
  const yesSource: ProfileSource = flags.yes !== undefined ? 'flag' : 'default';

  return {
    profile: profileSource,
    output: { mode: outputModeSource, color: colorSource },
    verbose: verboseSource,
    apiBaseUrl: apiBaseUrlSource,
    requestId: requestIdSource,
    yes: yesSource,
  };
}

function safeReadStore() {
  try {
    return readStore();
  } catch {
    return undefined;
  }
}
