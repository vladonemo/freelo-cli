export type LogoutData = {
  profile: string;
  removed: boolean;
};

/**
 * Human renderer for `freelo auth logout`.
 * Called only in `human` output mode (TTY).
 */
export function renderLogoutHuman(data: LogoutData): string {
  if (data.removed) {
    return `Logged out profile '${data.profile}'.`;
  }
  return `No credentials for profile '${data.profile}'; nothing to remove.`;
}
