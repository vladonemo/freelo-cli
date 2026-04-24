// Wrap `husky` install so it's a no-op when:
//   - running in CI (HUSKY=0 or CI=true with HUSKY unset),
//   - or the working tree is not a git checkout (e.g. user installed from npm).
// Keeping this in a script (not inline in package.json) avoids cross-platform
// shell quoting headaches.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

if (process.env.HUSKY === '0') {
  process.exit(0);
}
if (!existsSync(resolve(repoRoot, '.git'))) {
  process.exit(0);
}

try {
  const { default: husky } = await import('husky');
  const out = husky();
  if (out) process.stdout.write(out);
} catch (err) {
  // Husky not installed yet (first install before devDeps resolve in some
  // edge cases). Don't fail the install.
  process.stderr.write(`prepare-husky: skipping (${(err && err.message) || 'unknown'})\n`);
}
