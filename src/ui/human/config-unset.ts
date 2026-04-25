export type ConfigUnsetData = {
  key: string;
  previous_value: string | number | boolean | null;
  removed: boolean;
  scope: 'defaults' | 'profile';
  profile: string | null;
};

/**
 * Human renderer for `freelo config unset`.
 * Emits a contextual message depending on whether the key was actually removed.
 */
export function renderConfigUnsetHuman(data: ConfigUnsetData): string {
  if (!data.removed) {
    return `${data.key}: not set; nothing to do.`;
  }
  const prev = data.previous_value === null ? '<unset>' : String(data.previous_value);
  const profileSuffix = data.scope === 'profile' && data.profile ? `, profile ${data.profile}` : '';
  return `${data.key}: removed (was '${prev}') (${data.scope}${profileSuffix}).`;
}
