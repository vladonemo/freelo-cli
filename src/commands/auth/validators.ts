/**
 * Pure input validators for the `auth login` interactive prompts.
 *
 * These are extracted from the inline arrow functions in login.ts so they can
 * be unit-tested directly without needing a TTY or the Inquirer machinery.
 *
 * The signatures match the Inquirer `validate` callback contract:
 *   - return `true`   → the input is accepted
 *   - return `string` → the error message to display inline
 */

/** Validates the email prompt input for `auth login`. */
export function validateEmail(input: string): true | string {
  if (!input.trim()) return 'Email is required.';
  if (!/.+@.+\..+/.test(input)) return 'Enter a valid email address.';
  return true;
}

/** Validates the API-key (password) prompt input for `auth login`. */
export function validateApiKey(input: string): true | string {
  return input.trim() ? true : 'API token is required.';
}
