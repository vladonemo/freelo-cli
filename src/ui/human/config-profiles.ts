export type ConfigProfilesData = {
  current_profile: string | null;
  profiles: Array<{ name: string; email: string; api_base_url: string; current: boolean }>;
};

/**
 * Human renderer for `freelo config profiles`.
 * Lists profiles one per line, marking the current with `*`.
 */
export function renderConfigProfilesHuman(data: ConfigProfilesData): string {
  if (data.profiles.length === 0) {
    return `No profiles configured. Run 'freelo auth login' to create one.`;
  }
  const lines = data.profiles.map((p) => {
    const marker = p.current ? '* ' : '  ';
    return `${marker}${p.name} (${p.email}) — ${p.api_base_url}`;
  });
  return lines.join('\n');
}
