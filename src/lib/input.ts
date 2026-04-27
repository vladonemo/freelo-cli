/**
 * Shared input helper for write commands that accept rich-text content from
 * one of three sources: a file (`--from-file`), an interactive editor
 * (`--editor`), or stdin (`-`). First introduced for R15 (`tasks description
 * set`); will be reused by R17 (`comments add`), R22 (`reports edit`), etc.
 *
 * The helper is **pure dispatch + I/O** — it does not parse flags. The caller
 * picks the source; this module only turns that source into a UTF-8 string.
 *
 * Errors are typed `ValidationError` (exit 2) with a `hintNext` pointing at
 * the source's CLI flag, so the top-level handler can render a clean message.
 *
 * Spec 0026 §5.
 */

import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValidationError } from '../errors/validation-error.js';
import { readStdinToString } from './stdin.js';

/**
 * Declarative source spec. The caller decides which source to read from
 * based on the user's flag selection (e.g. `--from-file <path>` →
 * `{ kind: 'file', path }`).
 */
export type InputSource =
  | { kind: 'file'; path: string }
  | { kind: 'stdin' }
  | { kind: 'editor'; initialContent?: string };

export type ReadInputOptions = {
  signal?: AbortSignal;
  /**
   * Snapshot of `process.env` to use for editor resolution. Optional so the
   * helper still works when the caller doesn't have an env snapshot handy
   * (most tests). Production callers should pass the frozen env from
   * `src/bin/freelo.ts`.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Override the platform string. Test-only — production callers omit this.
   */
  platform?: NodeJS.Platform;
  /**
   * Override the TTY check. Test-only — production callers omit this.
   * When undefined, falls back to `process.stdin.isTTY`.
   */
  isTTY?: boolean;
};

export type ReadInputResult = {
  content: string;
  source: 'file' | 'editor' | 'stdin';
};

/**
 * Read a UTF-8 string from one of three sources.
 *
 * Spec 0026 §5.
 */
export async function readInput(
  source: InputSource,
  opts: ReadInputOptions = {},
): Promise<ReadInputResult> {
  if (source.kind === 'file') {
    return readFromFile(source.path);
  }
  if (source.kind === 'stdin') {
    return readFromStdin(opts);
  }
  return readFromEditor(source.initialContent ?? '', opts);
}

/* ---------------------------------------------------------------------------
 *  File source
 * ------------------------------------------------------------------------- */

async function readFromFile(path: string): Promise<ReadInputResult> {
  try {
    const content = await readFile(path, 'utf8');
    return { content, source: 'file' };
  } catch (err: unknown) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? (err as { code: unknown }).code
        : undefined;
    if (code === 'ENOENT') {
      throw new ValidationError(`File not found: ${path}`, {
        hintNext: 'Pass --from-file with a readable UTF-8 file path.',
      });
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new ValidationError(`Cannot read file (permission denied): ${path}`, {
        hintNext: 'Check the file permissions, or pass a different path via --from-file.',
      });
    }
    if (code === 'EISDIR') {
      throw new ValidationError(`Path is a directory, not a file: ${path}`, {
        hintNext: '--from-file expects a path to a UTF-8 text file.',
      });
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`Failed to read --from-file: ${detail}`, {
      hintNext: 'Check the path is a readable UTF-8 file.',
    });
  }
}

/* ---------------------------------------------------------------------------
 *  Stdin source
 * ------------------------------------------------------------------------- */

async function readFromStdin(opts: ReadInputOptions): Promise<ReadInputResult> {
  // Preserve the user's exact bytes — do NOT trim trailing newlines (a
  // description body legitimately can end with one).
  const content = await readStdinToString({
    trimTrailingNewline: false,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  return { content, source: 'stdin' };
}

/* ---------------------------------------------------------------------------
 *  Editor source
 * ------------------------------------------------------------------------- */

/**
 * Resolve the editor command. Order: `VISUAL`, `EDITOR`, then platform
 * default (`notepad.exe` on win32, `vi` elsewhere). Empty-string env values
 * are treated as unset.
 *
 * Returns `[executable, ...args]`. The temp file path is appended by the
 * caller (so the editor opens it).
 *
 * Spec 0026 §5.2.
 */
export function resolveEditor(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string[] {
  const visual = env['VISUAL'];
  const editor = env['EDITOR'];
  const chosen =
    visual !== undefined && visual.length > 0
      ? visual
      : editor !== undefined && editor.length > 0
        ? editor
        : platform === 'win32'
          ? 'notepad.exe'
          : 'vi';
  // Split on whitespace so `EDITOR='code --wait'` works. No shell parsing —
  // intentional simplicity. Users with complex needs can wrap in a shell
  // script.
  return chosen.split(/\s+/).filter((s) => s.length > 0);
}

async function readFromEditor(
  initialContent: string,
  opts: ReadInputOptions,
): Promise<ReadInputResult> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);

  if (!isTTY) {
    throw new ValidationError(
      '--editor requires an interactive terminal; pipe via `-` or use --from-file in non-TTY environments.',
      {
        hintNext:
          'In agent / CI contexts, pipe content to stdin with `-` or use --from-file <path>.',
      },
    );
  }

  // Create an isolated temp dir so concurrent runs don't collide.
  const dir = await mkdtemp(join(tmpdir(), 'freelo-input-'));
  const filePath = join(dir, 'edit.txt');
  try {
    // Pre-populate with initial content (existing description, if any).
    await writeFile(filePath, initialContent, 'utf8');

    const [executable, ...leadingArgs] = resolveEditor(env, platform);
    if (executable === undefined) {
      // Defensive — resolveEditor always returns at least one element.
      throw new ValidationError('Could not resolve an editor command.', {
        hintNext: 'Set $VISUAL or $EDITOR to your preferred editor command.',
      });
    }

    // Build the spawn env. Always start from `process.env` so PATH and
    // other shell essentials are available to the child (without PATH the
    // child can't resolve `node`/`vi`/etc. on POSIX, leading to ENOENT).
    // The caller's `opts.env` is treated as an overlay layered on top, so
    // tests can inject FREELO_FAKE_EDITOR_* vars without having to plumb
    // PATH themselves, and production callers (which pass the full frozen
    // env from src/bin/freelo.ts) keep the same effective env.
    // Filter out `undefined` values — spawnSync's env type rejects them.
    const spawnEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') spawnEnv[k] = v;
    }
    if (opts.env !== undefined) {
      for (const [k, v] of Object.entries(opts.env)) {
        if (typeof v === 'string') spawnEnv[k] = v;
      }
    }

    const result = spawnSync(executable, [...leadingArgs, filePath], {
      stdio: 'inherit',
      env: spawnEnv,
    });

    if (result.error) {
      throw new ValidationError(
        `Failed to launch editor (${executable}): ${result.error.message}`,
        {
          hintNext: 'Set $VISUAL or $EDITOR to a launchable editor command.',
        },
      );
    }
    if (result.signal !== null) {
      throw new ValidationError(`Editor was killed by signal ${result.signal}; aborting.`, {
        hintNext: 'Re-run and let the editor exit cleanly.',
      });
    }
    if (result.status !== 0) {
      throw new ValidationError(`Editor exited with status ${result.status ?? '?'}; aborting.`, {
        hintNext: 'Save and exit the editor without an error to commit the change.',
      });
    }

    const content = await readFile(filePath, 'utf8');
    return { content, source: 'editor' };
  } finally {
    // Best-effort cleanup. Never masks the original result/error.
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
