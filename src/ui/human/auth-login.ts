export type LoginData = {
  profile: string;
  email: string;
  user_id: number;
  replaced: boolean;
};

/**
 * Human renderer for `freelo auth login`.
 * Called only in `human` output mode (TTY).
 */
export function renderLoginHuman(data: LoginData): string {
  if (data.replaced) {
    return `Replaced token for profile '${data.profile}' (${data.email}).`;
  }
  return `Logged in as ${data.email} on profile '${data.profile}'.`;
}
