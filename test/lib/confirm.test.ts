/**
 * Unit tests for `src/lib/confirm.ts` (R13 spec 0024 §3.3).
 *
 * The shared confirmation gate for destructive operations. Six rows cover
 * the full decision matrix:
 *   - `--yes` bypasses unconditionally (sub-cases: TTY and non-TTY).
 *   - `--dry-run` bypasses unconditionally.
 *   - Non-TTY without `--yes` → throws `ConfirmationError` (exit 2,
 *     code `CONFIRMATION_REQUIRED`).
 *   - TTY without `--yes`, user accepts → returns void.
 *   - TTY without `--yes`, user declines → throws `ConfirmationError`.
 *   - Lazy-import discipline: confirm.ts has NO top-level static import of
 *     `@inquirer/prompts` (grep assertion — agent cold path stays slim).
 *
 * Calibration §1: every error path that the spec assigns an exit code MUST
 * have a test asserting that exit code. The two `ConfirmationError` paths
 * both assert `exitCode: 2` and `code: 'CONFIRMATION_REQUIRED'`.
 *
 * Calibration §4: branch coverage on confirm.ts is non-negotiable.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmDestructive } from '../../src/lib/confirm.js';
import { ConfirmationError } from '../../src/errors/confirmation-error.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('confirmDestructive — bypass paths', () => {
  it('returns void when --yes (TTY)', async () => {
    await expect(
      confirmDestructive({
        promptMessage: 'Delete 1 task?',
        yes: true,
        dryRun: false,
        isInteractive: () => true,
      }),
    ).resolves.toBeUndefined();
  });

  it('returns void when --yes (non-TTY) — explicit row to prove --yes overrides non-TTY-fail-closed', async () => {
    await expect(
      confirmDestructive({
        promptMessage: 'Delete 1 task?',
        yes: true,
        dryRun: false,
        isInteractive: () => false,
      }),
    ).resolves.toBeUndefined();
  });

  it('returns void when --dry-run (no --yes, non-TTY)', async () => {
    await expect(
      confirmDestructive({
        promptMessage: 'Delete 1 task?',
        yes: false,
        dryRun: true,
        isInteractive: () => false,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('confirmDestructive — non-TTY fail-closed', () => {
  it('throws ConfirmationError (exit 2) on non-TTY without --yes', async () => {
    let caught: unknown;
    try {
      await confirmDestructive({
        promptMessage: 'Delete 3 tasks?',
        yes: false,
        dryRun: false,
        isInteractive: () => false,
      });
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfirmationError);
    const typed = caught as ConfirmationError;
    expect(typed.code).toBe('CONFIRMATION_REQUIRED');
    expect(typed.exitCode).toBe(2);
    expect(typed.retryable).toBe(false);
    expect(typed.message).toContain('Delete 3 tasks?');
    expect(typed.hintNext).toContain('--yes');
  });
});

describe('confirmDestructive — TTY prompt branch', () => {
  it('returns void when TTY user accepts', async () => {
    // Mock @inquirer/prompts so the dynamic import inside confirm.ts
    // resolves to a stub that returns true.
    vi.doMock('@inquirer/prompts', () => ({
      confirm: vi.fn(() => Promise.resolve(true)),
    }));
    // confirm.ts uses dynamic `await import(...)` so a fresh module load
    // picks up the mocked module. Reset the module registry first.
    vi.resetModules();
    const { confirmDestructive: fresh } = await import('../../src/lib/confirm.js');
    await expect(
      fresh({
        promptMessage: 'Delete 1 task?',
        yes: false,
        dryRun: false,
        isInteractive: () => true,
      }),
    ).resolves.toBeUndefined();
  });

  it('throws ConfirmationError (exit 2) when TTY user declines', async () => {
    vi.doMock('@inquirer/prompts', () => ({
      confirm: vi.fn(() => Promise.resolve(false)),
    }));
    vi.resetModules();
    // Re-import the error class from the same module-graph instance as
    // the freshly-imported confirm helper. After vi.resetModules(), the
    // top-of-file `ConfirmationError` symbol points at the OLD module
    // graph; an `instanceof` check across graphs returns false.
    const { confirmDestructive: fresh } = await import('../../src/lib/confirm.js');
    const { ConfirmationError: FreshConfirmationError } = await import(
      '../../src/errors/confirmation-error.js'
    );
    let caught: unknown;
    try {
      await fresh({
        promptMessage: 'Delete 1 task?',
        yes: false,
        dryRun: false,
        isInteractive: () => true,
      });
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreshConfirmationError);
    const typed = caught as InstanceType<typeof FreshConfirmationError>;
    expect(typed.code).toBe('CONFIRMATION_REQUIRED');
    expect(typed.exitCode).toBe(2);
    expect(typed.message).toContain('Aborted by user');
  });
});

describe('confirmDestructive — lazy import discipline (calibration: agent cold path)', () => {
  it('confirm.ts has no top-level static import of @inquirer/prompts', () => {
    const src = readFileSync(resolve(__dirname, '../../src/lib/confirm.ts'), 'utf8');
    // Match a top-level static import (start of line OR semicolon-separated)
    // referencing @inquirer/prompts. Allow `await import('@inquirer/prompts')`
    // (dynamic) — that's the whole point.
    const lines = src.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // A static import always starts with `import ` and includes the
      // module specifier. Skip lines starting with `// ` (comments may
      // mention it for documentation) and lines containing `await import`.
      if (trimmed.startsWith('//')) continue;
      if (trimmed.includes('await import')) continue;
      // No `import … from '@inquirer/prompts'` should appear at top level.
      expect(trimmed.startsWith(`import `) && trimmed.includes('@inquirer/prompts')).toBe(false);
    }
  });
});
