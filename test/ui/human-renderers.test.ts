import { describe, expect, it } from 'vitest';
import { renderLoginHuman, type LoginData } from '../../src/ui/human/auth-login.js';
import { renderLogoutHuman, type LogoutData } from '../../src/ui/human/auth-logout.js';
import { renderWhoamiHuman, type WhoamiData } from '../../src/ui/human/auth-whoami.js';

describe('renderLoginHuman — not replaced', () => {
  const data: LoginData = {
    profile: 'default',
    email: 'alice@example.cz',
    user_id: 999,
    replaced: false,
  };

  it('returns a "Logged in as" message for a fresh profile', () => {
    const output = renderLoginHuman(data);
    expect(output).toContain('Logged in as alice@example.cz');
    expect(output).toContain("profile 'default'");
  });
});

describe('renderLoginHuman — replaced', () => {
  const data: LoginData = {
    profile: 'work',
    email: 'bob@example.cz',
    user_id: 888,
    replaced: true,
  };

  it('returns a "Replaced token" message when profile already existed', () => {
    const output = renderLoginHuman(data);
    expect(output).toContain("Replaced token for profile 'work'");
    expect(output).toContain('bob@example.cz');
  });

  it('does not contain "Logged in" when profile was replaced', () => {
    const output = renderLoginHuman(data);
    expect(output).not.toContain('Logged in as');
  });
});

describe('renderLogoutHuman — removed', () => {
  const data: LogoutData = { profile: 'default', removed: true };

  it('returns a "Logged out" message when the profile was removed', () => {
    const output = renderLogoutHuman(data);
    expect(output).toContain("Logged out profile 'default'");
  });
});

describe('renderLogoutHuman — not removed', () => {
  const data: LogoutData = { profile: 'ci', removed: false };

  it('returns a "nothing to remove" message when the profile was absent', () => {
    const output = renderLogoutHuman(data);
    expect(output).toContain('nothing to remove');
  });
});

describe('renderWhoamiHuman — full data', () => {
  const data: WhoamiData = {
    profile: 'default',
    profile_source: 'env',
    user_id: 12345,
    email: 'jane@example.cz',
    full_name: 'Jane Doe',
    api_base_url: 'https://api.freelo.io/v1',
  };

  it('includes profile label in output', () => {
    const output = renderWhoamiHuman(data);
    expect(output).toContain('Profile:');
    expect(output).toContain('default');
  });

  it('includes user_id in output', () => {
    const output = renderWhoamiHuman(data);
    expect(output).toContain('User ID:');
    expect(output).toContain('12345');
  });

  it('includes email in output', () => {
    const output = renderWhoamiHuman(data);
    expect(output).toContain('Email:');
    expect(output).toContain('jane@example.cz');
  });

  it('includes full_name when present', () => {
    const output = renderWhoamiHuman(data);
    expect(output).toContain('Jane Doe');
  });

  it('includes profile_source in the profile row', () => {
    const output = renderWhoamiHuman(data);
    expect(output).toContain('env');
  });
});

describe('renderWhoamiHuman — no full_name', () => {
  const data: WhoamiData = {
    profile: 'ci',
    profile_source: 'conf',
    user_id: 42,
    email: 'bot@ci.example.cz',
    api_base_url: 'https://api.freelo.io/v1',
  };

  it('falls back to <unknown> (id N) when full_name is absent', () => {
    const output = renderWhoamiHuman(data);
    expect(output).toContain('<unknown>');
    expect(output).toContain('42');
  });
});
