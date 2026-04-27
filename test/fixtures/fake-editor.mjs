#!/usr/bin/env node
/**
 * Tiny "editor" used by `test/lib/input.test.ts` to drive the `--editor`
 * code path without spawning a real editor in CI.
 *
 * Modes (controlled via env):
 *
 *   FREELO_FAKE_EDITOR_MODE=write        → write FREELO_FAKE_EDITOR_CONTENT
 *                                          (default 'edited content') to argv[2]
 *                                          and exit 0.
 *   FREELO_FAKE_EDITOR_MODE=fail         → exit non-zero (status from
 *                                          FREELO_FAKE_EDITOR_STATUS, default 1).
 *   FREELO_FAKE_EDITOR_MODE=read-only    → leave the file untouched and exit 0.
 *
 * Invoked as: `node test/fixtures/fake-editor.mjs <tempfile>`.
 */

import { writeFileSync } from 'node:fs';

const mode = process.env.FREELO_FAKE_EDITOR_MODE ?? 'write';
const file = process.argv[2];

if (!file) {
  process.stderr.write('fake-editor: missing argv[2] (tempfile path)\n');
  process.exit(99);
}

if (mode === 'fail') {
  const status = Number(process.env.FREELO_FAKE_EDITOR_STATUS ?? '1');
  process.exit(status);
}

if (mode === 'read-only') {
  process.exit(0);
}

// Default: write mode.
const content = process.env.FREELO_FAKE_EDITOR_CONTENT ?? 'edited content';
writeFileSync(file, content, 'utf8');
process.exit(0);
