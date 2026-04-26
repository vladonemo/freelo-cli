import { describe, it, expect } from 'vitest';
import {
  TasklistFullSchema,
  TasklistListDataSchema,
  TASKLIST_DEFAULT_FIELDS,
} from '../../../src/api/schemas/tasklist.js';

/**
 * R05 schema tests for `TasklistFullSchema`. Mirrors the project schema
 * tests; covers the R05.5 hardening (Bug #2 — `Currency.amount` accepts
 * both string and number).
 */

describe('TasklistFullSchema — minimum shape', () => {
  it('accepts a minimal record with only id and name', () => {
    const out = TasklistFullSchema.parse({ id: 1, name: 'Backlog' });
    expect(out).toEqual({ id: 1, name: 'Backlog' });
  });

  it('passthrough preserves undocumented fields', () => {
    const out = TasklistFullSchema.parse({
      id: 1,
      name: 'X',
      mystery_field: 'mystery',
    });
    expect((out as { mystery_field?: string }).mystery_field).toBe('mystery');
  });

  it('rejects when id is missing', () => {
    expect(() => TasklistFullSchema.parse({ name: 'X' })).toThrow();
  });

  it('rejects when name is missing', () => {
    expect(() => TasklistFullSchema.parse({ id: 1 })).toThrow();
  });
});

describe('TasklistFullSchema — null-tolerant optional fields', () => {
  it('accepts every optional field as null', () => {
    const input = {
      id: 1,
      name: 'X',
      date_add: null,
      date_edited_at: null,
      state: null,
      project: null,
      real_minutes_spent: null,
      budget: null,
      real_cost: null,
    };
    const out = TasklistFullSchema.parse(input);
    expect(out.budget).toBeNull();
    expect(out.real_cost).toBeNull();
    expect(out.project).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 *  R05.5 — Bug #2: Currency.amount accepts string|number, normalizes to string.
 * ------------------------------------------------------------------------- */

describe('R05.5 — Tasklist Currency.amount widens to string|number', () => {
  it('accepts amount as string and preserves it', () => {
    const out = TasklistFullSchema.parse({
      id: 1,
      name: 'X',
      budget: { amount: '5000', currency: 'CZK' },
    });
    expect(out.budget?.amount).toBe('5000');
  });

  it('accepts amount as integer and normalizes to string', () => {
    const out = TasklistFullSchema.parse({
      id: 1,
      name: 'X',
      budget: { amount: 5000, currency: 'CZK' },
    });
    expect(out.budget?.amount).toBe('5000');
    expect(typeof out.budget?.amount).toBe('string');
  });

  it('accepts amount as a fractional number and normalizes to string', () => {
    const out = TasklistFullSchema.parse({
      id: 1,
      name: 'X',
      real_cost: { amount: 1234.56, currency: 'EUR' },
    });
    expect(out.real_cost?.amount).toBe('1234.56');
  });

  it('rejects NaN', () => {
    expect(() =>
      TasklistFullSchema.parse({
        id: 1,
        name: 'X',
        budget: { amount: Number.NaN, currency: 'CZK' },
      }),
    ).toThrow();
  });

  it('rejects Infinity', () => {
    expect(() =>
      TasklistFullSchema.parse({
        id: 1,
        name: 'X',
        budget: { amount: Number.POSITIVE_INFINITY, currency: 'CZK' },
      }),
    ).toThrow();
  });
});

describe('TasklistListDataSchema', () => {
  it('parses a project-scoped payload', () => {
    const out = TasklistListDataSchema.parse({
      scope: 'project',
      project_id: 42,
      tasklists: [{ id: 1, name: 'Backlog' }],
    });
    expect(out.scope).toBe('project');
    expect(out.project_id).toBe(42);
  });

  it('parses an all-scoped payload with project_id: null', () => {
    const out = TasklistListDataSchema.parse({
      scope: 'all',
      project_id: null,
      tasklists: [],
    });
    expect(out.scope).toBe('all');
    expect(out.project_id).toBeNull();
  });

  it('preserves Currency.amount normalization through to the data envelope', () => {
    const out = TasklistListDataSchema.parse({
      scope: 'all',
      project_id: null,
      tasklists: [{ id: 1, name: 'X', budget: { amount: 9999, currency: 'CZK' } }],
    });
    expect(out.tasklists[0]?.budget?.amount).toBe('9999');
  });
});

describe('TASKLIST_DEFAULT_FIELDS', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(TASKLIST_DEFAULT_FIELDS)).toBe(true);
  });

  it('includes the budget and real_cost columns', () => {
    expect(TASKLIST_DEFAULT_FIELDS).toContain('budget');
    expect(TASKLIST_DEFAULT_FIELDS).toContain('real_cost');
  });
});
