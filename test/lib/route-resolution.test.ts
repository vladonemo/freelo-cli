import { describe, it, expect } from 'vitest';
import { resolveRoute } from '../../src/commands/tasks/list.js';

/**
 * Pure-function tests for the dispatch tree in spec 0017 §2.2.
 *
 * Two routes in v1:
 *  - /project/{p}/tasklist/{t}/tasks ← exactly one of each + no unsupported filter
 *  - /all-tasks ← every other combination
 *
 * The /tasklist/{id}/finished-tasks route is deferred to R07.5 (spec OQ #4)
 * — `resolveRoute` must never return it in v1.
 */
describe('resolveRoute', () => {
  it('no flags → /all-tasks', () => {
    expect(resolveRoute({})).toEqual({ endpoint: 'all-tasks', entityShape: 'task_full' });
  });

  it('only --project → /all-tasks', () => {
    expect(resolveRoute({ project: [42] })).toEqual({
      endpoint: 'all-tasks',
      entityShape: 'task_full',
    });
  });

  it('only --tasklist → /all-tasks', () => {
    expect(resolveRoute({ tasklist: [101] })).toEqual({
      endpoint: 'all-tasks',
      entityShape: 'task_full',
    });
  });

  it('exactly one --project + one --tasklist + no other filters → /project/{p}/tasklist/{t}/tasks', () => {
    expect(resolveRoute({ project: [42], tasklist: [101] })).toEqual({
      endpoint: 'tasklist-tasks',
      entityShape: 'task_summary',
    });
  });

  it('one --project + one --tasklist + --order-by → still per-tasklist (order is supported there)', () => {
    expect(resolveRoute({ project: [42], tasklist: [101], orderBy: 'name' })).toEqual({
      endpoint: 'tasklist-tasks',
      entityShape: 'task_summary',
    });
  });

  it('one --project + one --tasklist + --worker → falls through to /all-tasks', () => {
    expect(resolveRoute({ project: [42], tasklist: [101], worker: 7 })).toEqual({
      endpoint: 'all-tasks',
      entityShape: 'task_full',
    });
  });

  it('one --project + one --tasklist + --label → /all-tasks', () => {
    expect(resolveRoute({ project: [42], tasklist: [101], label: ['bug'] })).toEqual({
      endpoint: 'all-tasks',
      entityShape: 'task_full',
    });
  });

  it('multiple --project → /all-tasks even with one --tasklist', () => {
    expect(resolveRoute({ project: [42, 43], tasklist: [101] })).toEqual({
      endpoint: 'all-tasks',
      entityShape: 'task_full',
    });
  });

  it('multiple --tasklist → /all-tasks even with one --project', () => {
    expect(resolveRoute({ project: [42], tasklist: [101, 102] })).toEqual({
      endpoint: 'all-tasks',
      entityShape: 'task_full',
    });
  });

  it('--no-due → /all-tasks', () => {
    expect(resolveRoute({ project: [42], tasklist: [101], noDue: true })).toEqual({
      endpoint: 'all-tasks',
      entityShape: 'task_full',
    });
  });

  it('--finished-overdue → /all-tasks (per spec §8.5)', () => {
    expect(resolveRoute({ tasklist: [101], finishedOverdue: true })).toEqual({
      endpoint: 'all-tasks',
      entityShape: 'task_full',
    });
  });

  it('--search → /all-tasks (per OQ #1: filters the per-tasklist route doesnt support force /all-tasks)', () => {
    expect(resolveRoute({ project: [42], tasklist: [101], search: 'redesign' })).toEqual({
      endpoint: 'all-tasks',
      entityShape: 'task_full',
    });
  });
});
