// The version string is inlined at build time by tsup's `define` so the
// published binary is self-contained — no runtime fs lookup, no dependency on
// CWD, symlinks, or the package being installed in any particular layout.
//
// In tests and `pnpm dev` (tsx) we don't go through tsup, so we fall back to
// reading `package.json` from disk.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ConfigError } from '../errors/config-error.js';

declare const __FREELO_VERSION__: string | undefined;

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/lib/version.ts → ../../package.json
  const pkgPath = resolve(here, '..', '..', 'package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new ConfigError('package.json is missing a version string');
  }
  return parsed.version;
}

export const VERSION: string =
  typeof __FREELO_VERSION__ === 'string' && __FREELO_VERSION__.length > 0
    ? __FREELO_VERSION__
    : readPackageVersion();
