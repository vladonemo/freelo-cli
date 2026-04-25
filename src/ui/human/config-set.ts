export type ConfigSetData = {
  key: string;
  previous_value: string | number | boolean | null;
  value: string | number | boolean;
  scope: 'defaults' | 'profile';
  profile: string | null;
};

/**
 * Human renderer for `freelo config set`.
 * Emits: `<key>: '<previous>' -> '<value>' (<scope>[, profile <profile>]).`
 */
export function renderConfigSetHuman(data: ConfigSetData): string {
  const prev = data.previous_value === null ? '<unset>' : String(data.previous_value);
  const profileSuffix = data.scope === 'profile' && data.profile ? `, profile ${data.profile}` : '';
  return `${data.key}: '${prev}' -> '${String(data.value)}' (${data.scope}${profileSuffix}).`;
}
