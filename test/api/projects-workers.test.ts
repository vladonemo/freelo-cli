import { describe, expect, it } from 'vitest';
import {
  projectsWorkersRemoveByIdsPath,
  projectsWorkersRemoveByEmailsPath,
} from '../../src/api/projects-workers.js';

describe('projects-workers — wire path builders (R32 spec 0045)', () => {
  it('projectsWorkersRemoveByIdsPath embeds the project id', () => {
    expect(projectsWorkersRemoveByIdsPath(9001)).toBe('/project/9001/remove-workers/by-ids');
  });

  it('projectsWorkersRemoveByEmailsPath embeds the project id', () => {
    expect(projectsWorkersRemoveByEmailsPath(9001)).toBe('/project/9001/remove-workers/by-emails');
  });

  it('handles large project ids without overflow', () => {
    expect(projectsWorkersRemoveByIdsPath(2147483647)).toBe(
      '/project/2147483647/remove-workers/by-ids',
    );
    expect(projectsWorkersRemoveByEmailsPath(2147483647)).toBe(
      '/project/2147483647/remove-workers/by-emails',
    );
  });
});
