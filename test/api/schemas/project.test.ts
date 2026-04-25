import { describe, it, expect } from 'vitest';
import {
  ProjectWithTasklistsSchema,
  ProjectFullSchema,
  ProjectsBareArraySchema,
  paginatedProjectsWrapperSchema,
  ProjectListDataSchema,
  DEFAULT_FIELDS,
  INNER_KEY_BY_SCOPE,
} from '../../../src/api/schemas/project.js';

describe('ProjectWithTasklistsSchema', () => {
  it('accepts a minimal record with only id and name', () => {
    const out = ProjectWithTasklistsSchema.parse({ id: 1, name: 'Site' });
    expect(out).toEqual({ id: 1, name: 'Site' });
  });

  it('accepts a fully populated record', () => {
    const input = {
      id: 42,
      name: 'Site redesign',
      date_add: '2026-01-15T10:00:00+01:00',
      date_edited_at: '2026-04-20T14:32:00+01:00',
      tasklists: [{ id: 101, name: 'Backlog' }],
      client: { id: 7, email: 'c@example.cz', name: 'Acme', company: 'Acme s.r.o.' },
    };
    expect(ProjectWithTasklistsSchema.parse(input)).toEqual(input);
  });

  it('passthrough preserves undocumented fields', () => {
    const out = ProjectWithTasklistsSchema.parse({
      id: 1,
      name: 'X',
      mystery_field: 'x',
    });
    expect((out as { mystery_field?: string }).mystery_field).toBe('x');
  });

  it('rejects when name is missing', () => {
    expect(() => ProjectWithTasklistsSchema.parse({ id: 1 })).toThrow();
  });
});

describe('ProjectFullSchema', () => {
  it('accepts the rich shape with state and budget', () => {
    const input = {
      id: 50,
      name: 'R&D',
      date_add: '2026-01-15T10:00:00+01:00',
      owner: { id: 9, fullname: 'Owner Name' },
      state: { id: 1, state: 'active' as const },
      minutes_budget: 600,
      budget: { amount: '10000', currency: 'CZK' as const },
      real_minutes_spent: 120,
      real_cost: { amount: '2000', currency: 'CZK' as const },
    };
    expect(ProjectFullSchema.parse(input)).toEqual(input);
  });

  it('tolerates minutes_budget: null', () => {
    const out = ProjectFullSchema.parse({ id: 1, name: 'X', minutes_budget: null });
    expect(out.minutes_budget).toBeNull();
  });

  it('rejects unknown state enum', () => {
    expect(() =>
      ProjectFullSchema.parse({ id: 1, name: 'X', state: { id: 99, state: 'bogus' } }),
    ).toThrow();
  });
});

describe('ProjectsBareArraySchema', () => {
  it('accepts an empty array', () => {
    expect(ProjectsBareArraySchema.parse([])).toEqual([]);
  });

  it('accepts an array of project records', () => {
    const arr = [
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
    ];
    expect(ProjectsBareArraySchema.parse(arr)).toEqual(arr);
  });

  it('rejects a non-array', () => {
    expect(() => ProjectsBareArraySchema.parse({ data: { projects: [] } })).toThrow();
  });
});

describe('paginatedProjectsWrapperSchema', () => {
  it('parses a wrapper with the expected inner key', () => {
    const schema = paginatedProjectsWrapperSchema('projects', ProjectFullSchema);
    const raw = {
      total: 75,
      count: 25,
      page: 0,
      per_page: 25,
      data: { projects: [{ id: 1, name: 'X' }] },
    };
    const parsed = schema.parse(raw);
    expect(parsed.total).toBe(75);
    expect(parsed.data['projects']?.length).toBe(1);
  });

  it('rejects a wrapper missing the inner key', () => {
    const schema = paginatedProjectsWrapperSchema('invited_projects', ProjectWithTasklistsSchema);
    expect(() => schema.parse({ total: 0, count: 0, page: 0, per_page: 25, data: {} })).toThrow();
  });
});

describe('ProjectListDataSchema', () => {
  it('parses a with_tasklists payload', () => {
    const out = ProjectListDataSchema.parse({
      entity_shape: 'with_tasklists',
      scope: 'owned',
      projects: [{ id: 1, name: 'X' }],
    });
    expect(out.entity_shape).toBe('with_tasklists');
  });

  it('parses a full payload (scope: all)', () => {
    const out = ProjectListDataSchema.parse({
      entity_shape: 'full',
      scope: 'all',
      projects: [{ id: 1, name: 'X' }],
    });
    expect(out.entity_shape).toBe('full');
  });

  it('rejects entity_shape: full with non-all scope', () => {
    expect(() =>
      ProjectListDataSchema.parse({
        entity_shape: 'full',
        scope: 'owned',
        projects: [],
      }),
    ).toThrow();
  });
});

describe('DEFAULT_FIELDS / INNER_KEY_BY_SCOPE', () => {
  it('has an entry per scope', () => {
    expect(Object.keys(DEFAULT_FIELDS).sort()).toEqual([
      'all',
      'archived',
      'invited',
      'owned',
      'templates',
    ]);
  });

  it('has frozen arrays', () => {
    const arr = DEFAULT_FIELDS.owned;
    expect(Object.isFrozen(arr)).toBe(true);
  });

  it('maps scopes to wire-format inner keys', () => {
    expect(INNER_KEY_BY_SCOPE.invited).toBe('invited_projects');
    expect(INNER_KEY_BY_SCOPE.archived).toBe('archived_projects');
    expect(INNER_KEY_BY_SCOPE.templates).toBe('template_projects');
    expect(INNER_KEY_BY_SCOPE.all).toBe('projects');
  });
});
