/**
 * Unit tests for `src/lib/input.ts` (R15, spec 0026 §5).
 *
 * Covers:
 *   - File source: happy path, ENOENT, EISDIR, EACCES (best-effort).
 *   - Stdin source: piped content, empty stdin.
 *   - Editor source: TTY guard, fake-editor success, fake-editor non-zero.
 *   - resolveEditor: VISUAL beats EDITOR, empty env falls through, platform
 *     defaults (win32 → notepad.exe, else → vi).
 *
 * Calibration §2: every typed error class triggered (here only
 * ValidationError exit 2) gets an exit-code assertion.
 *
 * Calibration §4: every new try/catch arm in src/lib/input.ts has a
 * triggering test (file ENOENT, file EISDIR, editor non-zero, editor
 * spawn-error).
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readInput, resolveEditor } from '../../src/lib/input.js';
import { ValidationError } from '../../src/errors/validation-error.js';

// Absolute path to the fake editor script. Resolved once at module load.
const FAKE_EDITOR = fileURLToPath(new URL('../fixtures/fake-editor.mjs', import.meta.url));

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'freelo-input-test-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  try {
    await rm(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
//  resolveEditor
// ---------------------------------------------------------------------------

describe('resolveEditor', () => {
  it('returns VISUAL when set (beats EDITOR)', () => {
    expect(resolveEditor({ VISUAL: 'vim', EDITOR: 'nano' }, 'linux')).toEqual(['vim']);
  });

  it('returns EDITOR when VISUAL is unset', () => {
    expect(resolveEditor({ EDITOR: 'nano' }, 'linux')).toEqual(['nano']);
  });

  it('treats empty VISUAL as unset, falls through to EDITOR', () => {
    expect(resolveEditor({ VISUAL: '', EDITOR: 'nano' }, 'linux')).toEqual(['nano']);
  });

  it('treats empty EDITOR as unset, falls through to platform default', () => {
    expect(resolveEditor({ VISUAL: '', EDITOR: '' }, 'linux')).toEqual(['vi']);
  });

  it('falls through to vi on linux when no env is set', () => {
    expect(resolveEditor({}, 'linux')).toEqual(['vi']);
  });

  it('falls through to notepad.exe on win32 when no env is set', () => {
    expect(resolveEditor({}, 'win32')).toEqual(['notepad.exe']);
  });

  it('splits multi-token editor strings (e.g. "code --wait")', () => {
    expect(resolveEditor({ EDITOR: 'code --wait' }, 'linux')).toEqual(['code', '--wait']);
  });
});

// ---------------------------------------------------------------------------
//  File source
// ---------------------------------------------------------------------------

describe('readInput — file source', () => {
  it('reads a UTF-8 file and returns content + source="file"', async () => {
    const path = join(workDir, 'note.txt');
    await writeFile(path, 'Hello, world!\nMultiline content.', 'utf8');

    const result = await readInput({ kind: 'file', path });
    expect(result.content).toBe('Hello, world!\nMultiline content.');
    expect(result.source).toBe('file');
  });

  it('throws ValidationError exit 2 on ENOENT', async () => {
    const path = join(workDir, 'does-not-exist.txt');
    let caught: unknown;
    try {
      await readInput({ kind: 'file', path });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const ve = caught as ValidationError;
    expect(ve.exitCode).toBe(2);
    expect(ve.message).toContain('not found');
    expect(ve.hintNext).toContain('--from-file');
  });

  it('throws ValidationError exit 2 on EISDIR (path is a directory)', async () => {
    const dirPath = join(workDir, 'a-dir');
    await mkdir(dirPath);

    let caught: unknown;
    try {
      await readInput({ kind: 'file', path: dirPath });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const ve = caught as ValidationError;
    expect(ve.exitCode).toBe(2);
    // On POSIX this maps via EISDIR; on Windows readFile on a dir surfaces a
    // different code (EISDIR or EPERM). Either way the message contains the
    // path; we check for a clear indication that it's not a regular file.
    expect(ve.message).toMatch(/directory|read|not a file/i);
  });
});

// ---------------------------------------------------------------------------
//  Stdin source
// ---------------------------------------------------------------------------

describe('readInput — stdin source', () => {
  // Mock src/lib/stdin.ts directly — mirrors the pattern in
  // `test/commands/auth/login.test.ts` for `--api-key-stdin`. Reaching into
  // process.stdin via Readable.from is unreliable in vitest's process model.

  it('reads piped content (passes trimTrailingNewline=false)', async () => {
    let observedTrim: boolean | undefined;
    vi.doMock('../../src/lib/stdin.js', () => ({
      readStdinToString: vi.fn((opts?: { trimTrailingNewline?: boolean }) => {
        observedTrim = opts?.trimTrailingNewline;
        return Promise.resolve('hello stdin\n');
      }),
    }));
    vi.resetModules();

    const { readInput: readInputFresh } = await import('../../src/lib/input.js');
    const result = await readInputFresh({ kind: 'stdin' });
    expect(result.source).toBe('stdin');
    expect(result.content).toBe('hello stdin\n');
    // The helper must preserve exact bytes — no trailing-newline trimming.
    expect(observedTrim).toBe(false);

    vi.doUnmock('../../src/lib/stdin.js');
    vi.resetModules();
  });

  it('returns empty string on empty stdin', async () => {
    vi.doMock('../../src/lib/stdin.js', () => ({
      readStdinToString: vi.fn(() => Promise.resolve('')),
    }));
    vi.resetModules();

    const { readInput: readInputFresh } = await import('../../src/lib/input.js');
    const result = await readInputFresh({ kind: 'stdin' });
    expect(result.source).toBe('stdin');
    expect(result.content).toBe('');

    vi.doUnmock('../../src/lib/stdin.js');
    vi.resetModules();
  });
});

// ---------------------------------------------------------------------------
//  Editor source
// ---------------------------------------------------------------------------

describe('readInput — editor source', () => {
  it('throws ValidationError exit 2 when stdin is not a TTY', async () => {
    let caught: unknown;
    try {
      await readInput(
        { kind: 'editor' },
        {
          isTTY: false,
          env: { EDITOR: 'node' },
          platform: 'linux',
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const ve = caught as ValidationError;
    expect(ve.exitCode).toBe(2);
    expect(ve.message).toContain('interactive');
  });

  it('runs editor and returns the content it wrote (success path)', async () => {
    const result = await readInput(
      { kind: 'editor', initialContent: 'pre-existing' },
      {
        isTTY: true,
        env: {
          EDITOR: `node ${FAKE_EDITOR}`,
          FREELO_FAKE_EDITOR_MODE: 'write',
          FREELO_FAKE_EDITOR_CONTENT: 'edited result',
        },
        platform: 'linux',
      },
    );
    expect(result.source).toBe('editor');
    expect(result.content).toBe('edited result');
  });

  it('throws ValidationError exit 2 when the editor exits non-zero', async () => {
    let caught: unknown;
    try {
      await readInput(
        { kind: 'editor' },
        {
          isTTY: true,
          env: {
            EDITOR: `node ${FAKE_EDITOR}`,
            FREELO_FAKE_EDITOR_MODE: 'fail',
            FREELO_FAKE_EDITOR_STATUS: '1',
          },
          platform: 'linux',
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const ve = caught as ValidationError;
    expect(ve.exitCode).toBe(2);
    expect(ve.message).toMatch(/status|exited/i);
  });

  it('preserves the initialContent when the editor leaves the file untouched', async () => {
    const result = await readInput(
      { kind: 'editor', initialContent: 'untouched' },
      {
        isTTY: true,
        env: {
          EDITOR: `node ${FAKE_EDITOR}`,
          FREELO_FAKE_EDITOR_MODE: 'read-only',
        },
        platform: 'linux',
      },
    );
    expect(result.source).toBe('editor');
    expect(result.content).toBe('untouched');
  });

  it('throws ValidationError exit 2 when the editor command cannot be launched', async () => {
    let caught: unknown;
    try {
      await readInput(
        { kind: 'editor' },
        {
          isTTY: true,
          env: { EDITOR: 'this-binary-does-not-exist-anywhere-12345' },
          platform: 'linux',
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const ve = caught as ValidationError;
    expect(ve.exitCode).toBe(2);
    // Either the spawn errored (.error set → "Failed to launch editor") OR
    // status != 0 ("Editor exited with status N"). Both are valid failure
    // surfaces and both map to ValidationError exit 2.
    expect(ve.message).toMatch(/launch|exited|status/i);
  });
});
