export type ConfigUseData = {
  previous_profile: string | null;
  profile: string;
  changed: boolean;
};

/**
 * Human renderer for `freelo config use`.
 */
export function renderConfigUseHuman(data: ConfigUseData): string {
  if (!data.changed) {
    return `Profile already active: ${data.profile}.`;
  }
  const prev = data.previous_profile ?? '<none>';
  return `Switched profile: ${prev} -> ${data.profile}.`;
}
