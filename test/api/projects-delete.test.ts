import { describe, expect, it } from 'vitest';
import { projectDeletePath } from '../../src/api/projects-delete.js';

describe('projectDeletePath', () => {
  it('returns /project/{id}', () => {
    expect(projectDeletePath(9001)).toBe('/project/9001');
    expect(projectDeletePath(42)).toBe('/project/42');
  });

  it('different ids produce different paths', () => {
    expect(projectDeletePath(1)).not.toBe(projectDeletePath(2));
  });
});
