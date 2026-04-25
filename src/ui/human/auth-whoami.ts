import { type ProfileSource } from '../../config/schema.js';

export type WhoamiData = {
  profile: string;
  profile_source: ProfileSource;
  user_id: number;
  email: string;
  full_name?: string;
  api_base_url: string;
};

/**
 * Human renderer for `freelo auth whoami`.
 * Emits labelled rows; no ASCII chrome or emoji.
 */
export function renderWhoamiHuman(data: WhoamiData): string {
  const lines = [
    `Profile:     ${data.profile} (source: ${data.profile_source})`,
    `User:        ${data.full_name ?? `<unknown> (id ${data.user_id})`}`,
    `User ID:     ${data.user_id}`,
    `Email:       ${data.email}`,
    `API base:    ${data.api_base_url}`,
  ];
  return lines.join('\n');
}
