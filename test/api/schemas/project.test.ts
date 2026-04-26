import { describe, it, expect } from 'vitest';
import {
  ProjectWithTasklistsSchema,
  ProjectFullSchema,
  ProjectsBareArraySchema,
  paginatedProjectsWrapperSchema,
  ProjectListDataSchema,
  ProjectDetailSchema,
  UserBasicSchema,
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

  it('accepts client: null (real Freelo response shape)', () => {
    const out = ProjectWithTasklistsSchema.parse({ id: 1, name: 'X', client: null });
    expect(out.client).toBeNull();
  });

  it('accepts tasklists: null', () => {
    const out = ProjectWithTasklistsSchema.parse({ id: 1, name: 'X', tasklists: null });
    expect(out.tasklists).toBeNull();
  });

  it('accepts date_add / date_edited_at: null', () => {
    const out = ProjectWithTasklistsSchema.parse({
      id: 1,
      name: 'X',
      date_add: null,
      date_edited_at: null,
    });
    expect(out.date_add).toBeNull();
    expect(out.date_edited_at).toBeNull();
  });

  it('accepts a Client with all string fields nullable', () => {
    const input = {
      id: 1,
      name: 'X',
      client: {
        id: 7,
        email: null,
        name: null,
        company: null,
        company_id: null,
        company_tax_id: null,
        street: null,
        town: null,
        zip: null,
      },
    };
    const out = ProjectWithTasklistsSchema.parse(input);
    expect(out.client).toEqual(input.client);
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

  it('accepts every previously-optional complex field as null', () => {
    const input = {
      id: 1,
      name: 'X',
      date_add: null,
      date_edited_at: null,
      owner: null,
      state: null,
      minutes_budget: null,
      budget: null,
      real_minutes_spent: null,
      real_cost: null,
    };
    const out = ProjectFullSchema.parse(input);
    expect(out.owner).toBeNull();
    expect(out.state).toBeNull();
    expect(out.budget).toBeNull();
    expect(out.real_cost).toBeNull();
    expect(out.real_minutes_spent).toBeNull();
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

/* ------------------------------------------------------------------------- *
 *  R05.5 — Bug #1: UserBasic.fullname is nullable + optional
 *
 *  Live Freelo API can return user objects without a fullname (deleted users,
 *  externally-invited pending users, system actors). The schema must accept
 *  these payloads without throwing. See spec 0015 §1.
 * ------------------------------------------------------------------------- */

describe('R05.5 — UserBasicSchema tolerates missing/null fullname', () => {
  it('accepts a user with id only (no fullname field)', () => {
    const out = UserBasicSchema.parse({ id: 99 });
    expect(out.id).toBe(99);
    expect(out.fullname).toBeUndefined();
  });

  it('accepts a user with fullname: null', () => {
    const out = UserBasicSchema.parse({ id: 99, fullname: null });
    expect(out.fullname).toBeNull();
  });

  it('still accepts a user with fullname populated', () => {
    const out = UserBasicSchema.parse({ id: 99, fullname: 'Jane Doe' });
    expect(out.fullname).toBe('Jane Doe');
  });

  it('still rejects a user without an id (id is the primary key)', () => {
    expect(() => UserBasicSchema.parse({ fullname: 'Anon' })).toThrow();
  });
});

describe('R05.5 — ProjectFull.owner accepts a UserBasic without fullname', () => {
  it('parses a project whose owner has only an id', () => {
    const out = ProjectFullSchema.parse({
      id: 1,
      name: 'X',
      owner: { id: 9 },
    });
    const owner = out.owner as { id: number; fullname?: string | null };
    expect(owner.id).toBe(9);
    expect(owner.fullname).toBeUndefined();
  });
});

describe('R05.5 — ProjectDetail.workers tolerates missing fullname / partial hour_rate', () => {
  it('parses a worker without fullname', () => {
    const out = ProjectDetailSchema.parse({
      id: 1,
      name: 'X',
      workers: [{ id: 17 }],
    });
    expect(out.workers?.[0]?.id).toBe(17);
  });

  it('parses a worker with hour_rate fields all null/missing', () => {
    const out = ProjectDetailSchema.parse({
      id: 1,
      name: 'X',
      workers: [{ id: 17, fullname: 'Jane', hour_rate: { amount: null, currency: null } }],
    });
    expect(out.workers?.[0]?.hour_rate?.amount).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 *  R05.5 — Bug #2: CurrencySchema accepts numeric amounts and normalizes to
 *  string. Live Freelo API returns `amount` as a number for `real_cost` and
 *  `budget` on multiple endpoints. Public envelope contract is `string`, so
 *  the schema parses-and-transforms to a canonical string.
 * ------------------------------------------------------------------------- */

describe('R05.5 — Currency.amount widens to string|number, normalizes to string', () => {
  it('accepts amount as a string and preserves it', () => {
    const out = ProjectFullSchema.parse({
      id: 1,
      name: 'X',
      real_cost: { amount: '2000', currency: 'CZK' },
    });
    expect(out.real_cost?.amount).toBe('2000');
  });

  it('accepts amount as an integer and normalizes to string', () => {
    const out = ProjectFullSchema.parse({
      id: 1,
      name: 'X',
      real_cost: { amount: 2000, currency: 'CZK' },
    });
    expect(out.real_cost?.amount).toBe('2000');
    expect(typeof out.real_cost?.amount).toBe('string');
  });

  it('accepts amount as a fractional number and normalizes to string', () => {
    const out = ProjectFullSchema.parse({
      id: 1,
      name: 'X',
      budget: { amount: 15000.5, currency: 'EUR' },
    });
    expect(out.budget?.amount).toBe('15000.5');
  });

  it('rejects amount: NaN (not a real value)', () => {
    expect(() =>
      ProjectFullSchema.parse({
        id: 1,
        name: 'X',
        real_cost: { amount: Number.NaN, currency: 'CZK' },
      }),
    ).toThrow();
  });

  it('rejects amount: Infinity (not a real value)', () => {
    expect(() =>
      ProjectFullSchema.parse({
        id: 1,
        name: 'X',
        real_cost: { amount: Number.POSITIVE_INFINITY, currency: 'CZK' },
      }),
    ).toThrow();
  });

  it('rejects an unknown currency code (existing posture; not loosened)', () => {
    expect(() =>
      ProjectFullSchema.parse({
        id: 1,
        name: 'X',
        real_cost: { amount: 100, currency: 'GBP' },
      }),
    ).toThrow();
  });

  it('exercises both budget and real_cost on the same record', () => {
    const out = ProjectFullSchema.parse({
      id: 1,
      name: 'X',
      budget: { amount: 50000, currency: 'CZK' },
      real_cost: { amount: 12345, currency: 'CZK' },
    });
    expect(out.budget?.amount).toBe('50000');
    expect(out.real_cost?.amount).toBe('12345');
  });
});
