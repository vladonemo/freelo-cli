import { cosmiconfigSync } from 'cosmiconfig';
import { type RcConfig, RcConfigSchema } from './rc-schema.js';
import { ConfigError } from '../errors/config-error.js';

/**
 * Module-level cosmiconfig instance. Cached per process; reset between tests
 * via `_resetRcCache()`.
 *
 * We explicitly restrict to JSON and YAML discovery only — no JS/TS loaders.
 * Loading user code on every CLI invocation would be a security surface.
 * See spec §2.6 and §7 #3 for the design decision.
 */
let _explorer: ReturnType<typeof cosmiconfigSync> | undefined;

function getExplorer(): ReturnType<typeof cosmiconfigSync> {
  if (_explorer) return _explorer;
  _explorer = cosmiconfigSync('freelo', {
    // Only these search places — JSON and YAML, no JS/TS.
    searchPlaces: ['.freelorc', '.freelorc.json', '.freelorc.yaml', '.freelorc.yml'],
    // By not registering loaders for .js/.ts, cosmiconfig will not attempt
    // to load those file types even if they are present in the search path.
    loaders: {
      // cosmiconfig's built-in YAML loader (js-yaml) handles .yaml/.yml.
      // The default JSON loader handles .json and extension-less JSON files.
      // We explicitly set them to the built-in defaults so nothing else leaks.
      noExt: (filepath: string, content: string) => {
        // Extension-less files are treated as JSON (not YAML, not JS).
        try {
          return JSON.parse(content) as unknown;
        } catch (err) {
          throw new ConfigError(
            `Project rc file at ${filepath} is not valid JSON.`,
            { kind: 'corrupt-rc', path: filepath },
            { cause: err },
          );
        }
      },
    },
    cache: true,
  });
  return _explorer;
}

/** Exported for tests to reset the cosmiconfig cache between test cases. */
export function _resetRcCache(): void {
  _explorer = undefined;
}

/**
 * Synchronously discover and load a `.freelorc.*` file walking up from `cwd`.
 *
 * Returns `null` when no rc file is found in the directory tree.
 *
 * Throws `ConfigError({ kind: 'corrupt-rc', path })` when:
 * - the rc file exists but fails zod validation (unknown keys, bad values), or
 * - the rc file cannot be parsed (malformed YAML/JSON).
 *
 * The `ConfigError` for `corrupt-rc` has `exitCode: 2` (user-correctable)
 * per spec §7 #5.
 */
export function loadRcSync(cwd: string): { config: RcConfig; filepath: string } | null {
  const explorer = getExplorer();

  let result: ReturnType<typeof explorer.search>;
  try {
    result = explorer.search(cwd);
  } catch (err) {
    // cosmiconfig throws on YAML parse errors etc. Convert to ConfigError.
    const message = err instanceof Error ? err.message : String(err);
    // Try to extract a filepath from the error for the hint.
    const path = (err as { filepath?: string }).filepath ?? cwd;
    throw new ConfigError(
      `Project rc file at ${path} could not be parsed: ${message}`,
      { kind: 'corrupt-rc', path },
      { cause: err },
    );
  }

  if (!result || result.isEmpty) {
    return null;
  }

  const parsed = RcConfigSchema.safeParse(result.config);
  if (!parsed.success) {
    const offendingKeys = parsed.error.issues.map((i) => i.path.join('.') || i.message).join(', ');
    throw new ConfigError(
      `Project rc file at ${result.filepath} has invalid or disallowed keys: ${offendingKeys}`,
      { kind: 'corrupt-rc', path: result.filepath },
    );
  }

  return { config: parsed.data, filepath: result.filepath };
}
