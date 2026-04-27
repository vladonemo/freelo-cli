/**
 * Shared confirmation gate for destructive operations.
 *
 * R13 introduces this; reused byte-for-byte by every later destructive command
 * (`tasks archive`, `subtasks delete`, `comments delete`, `files delete`,
 * `projects delete`, `tasklists delete`, …). The contract is intentionally
 * narrow:
 *
 *   - `--yes` (no matter the TTY state) → proceed silently.
 *   - `--dry-run` → proceed silently. There is no destructive effect, so a
 *     prompt would be friction with no security benefit.
 *   - TTY without `--yes` → lazy-import `@inquirer/prompts` and prompt the
 *     user. Default is `false` (Enter aborts — safest default for a delete).
 *     User accepts → proceed. User declines → throw `ConfirmationError`.
 *   - **Non-TTY without `--yes`, no `--dry-run` → throw `ConfirmationError`
 *     immediately.** Never prompt — would hang waiting on stdin which is
 *     either piped (NDJSON input) or absent. Fail closed.
 *
 * Any throw is `ConfirmationError` (`code: 'CONFIRMATION_REQUIRED'`,
 * `exitCode: 2`). Callers that want to convert "user declined" into something
 * else (e.g. a per-line batch error) catch and re-classify, but the
 * default contract for a single-id flow is "throw on no, propagate to top-
 * level handler".
 *
 * Spec 0024 §3.3.
 */

import { ConfirmationError } from '../errors/confirmation-error.js';
import { isInteractive as defaultIsInteractive } from './env.js';

export type ConfirmOptions = {
  /**
   * The yes/no question shown to the TTY user. Echoed (slightly rephrased)
   * in the `ConfirmationError.message` so non-TTY callers see the intent.
   *
   * Example: `'Delete 3 task(s)?'`.
   */
  promptMessage: string;

  /** When the user passed `--yes`. Bypasses both the prompt and the throw. */
  yes: boolean;

  /**
   * When the user passed `--dry-run`. Skips confirmation entirely (no
   * destructive effect, so no security tradeoff to enforce here).
   */
  dryRun: boolean;

  /**
   * Override TTY detection for tests. Defaults to `isInteractive()` from
   * `src/lib/env.ts` (which checks `stdout.isTTY && stdin.isTTY && !CI`).
   *
   * Tests inject a deterministic function so they don't have to muck with
   * global `process.stdout.isTTY` state, which is brittle under vitest's
   * parallel test runner.
   */
  isInteractive?: () => boolean;
};

/**
 * Returns `void` on confirmation (proceed). Throws `ConfirmationError` when
 * the user declines or non-TTY mode forbids prompting.
 *
 * The function is `async` because the TTY prompt is async; the non-TTY and
 * `--yes` / `--dry-run` paths resolve synchronously but match the same
 * signature so callers can `await` uniformly.
 *
 * Pure of HTTP/config dependencies — only imports the typed error class
 * (sync) and lazy-imports `@inquirer/prompts` on the TTY-prompt path so
 * the agent cold path never pulls it in.
 */
export async function confirmDestructive(opts: ConfirmOptions): Promise<void> {
  // 1. `--yes` → unconditional proceed. Highest precedence: agents pass it
  //    explicitly to opt out of any confirmation logic.
  if (opts.yes) return;

  // 2. `--dry-run` → proceed without prompting. No destructive effect, no
  //    security boundary to enforce.
  if (opts.dryRun) return;

  // 3. TTY detection. Default to the real `isInteractive()`; tests inject.
  const isTty = (opts.isInteractive ?? defaultIsInteractive)();

  // 4. Non-TTY without `--yes` → fail closed. Never prompt — stdin is either
  //    piped (NDJSON input) or unavailable; a prompt would hang.
  if (!isTty) {
    throw new ConfirmationError(
      `${opts.promptMessage} Refusing in non-interactive mode without --yes.`,
      {
        hintNext: 'Pass --yes to bypass the prompt, or run from a TTY.',
      },
    );
  }

  // 5. TTY without `--yes` → prompt. Lazy import keeps `@inquirer/prompts`
  //    off the agent cold path (calibration: see `src/commands/auth/login.ts`
  //    for the same pattern).
  const { confirm } = await import('@inquirer/prompts');
  const accepted = await confirm({
    message: opts.promptMessage,
    default: false,
  });

  // 6. User declined → throw. Same error class as the non-TTY path so
  //    callers' top-level handler maps consistently.
  if (!accepted) {
    throw new ConfirmationError(`${opts.promptMessage} Aborted by user.`, {
      hintNext: 'Re-run with --yes to bypass the prompt.',
    });
  }

  // Otherwise: accepted → return void (proceed).
}
