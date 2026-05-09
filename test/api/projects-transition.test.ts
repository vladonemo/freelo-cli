import { describe, expect, it } from 'vitest';
import { projectsTransitionPath } from '../../src/api/projects-transition.js';

describe('projectsTransitionPath', () => {
  it('archive verb → /project/{id}/archive', () => {
    expect(projectsTransitionPath('archive', 9001)).toBe('/project/9001/archive');
  });

  it('activate verb → /project/{id}/activate', () => {
    expect(projectsTransitionPath('activate', 42)).toBe('/project/42/activate');
  });

  it('different ids produce different paths', () => {
    expect(projectsTransitionPath('archive', 1)).not.toBe(projectsTransitionPath('archive', 2));
    expect(projectsTransitionPath('archive', 1)).not.toBe(projectsTransitionPath('activate', 1));
  });
});
