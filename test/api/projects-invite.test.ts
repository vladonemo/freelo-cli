import { describe, it, expect } from 'vitest';
import { projectsInvitePath } from '../../src/api/projects-invite.js';

describe('projectsInvitePath', () => {
  it('returns the canonical /users/manage-workers path', () => {
    expect(projectsInvitePath()).toBe('/users/manage-workers');
  });
});
