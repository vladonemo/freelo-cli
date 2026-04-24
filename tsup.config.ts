import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'tsup';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: { freelo: 'src/bin/freelo.ts' },
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  shims: false,
  dts: false,
  treeshake: true,
  minify: false,
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __FREELO_VERSION__: JSON.stringify(pkg.version),
  },
});
