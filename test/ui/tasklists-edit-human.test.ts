/**
 * Unit tests for `renderTasklistsEditHuman` (M02, spec 0065).
 *
 * Pure function, no I/O — these cover the per-field change lines and the
 * partial-success warning at the renderer level rather than through a full
 * CLI invocation. Asserting the prompt/warning copy here (instead of only in
 * an integration test) also keeps it out of reach of the `isInteractive()`
 * gate that calibration §7 warns about.
 */

import { describe, expect, it } from 'vitest';
import { renderTasklistsEditHuman } from '../../src/ui/human/tasklists-edit.js';
import { type TasklistsEditData } from '../../src/api/schemas/tasklist.js';

function data(over: Partial<TasklistsEditData>): TasklistsEditData {
  return {
    tasklist_id: 9001,
    priority_requested: false,
    priority_applied: true,
    applied_changes: {},
    ...over,
  };
}

describe('renderTasklistsEditHuman — live success', () => {
  it('renders the headline with the tasklist id', () => {
    const out = renderTasklistsEditHuman(data({ applied_changes: { name: 'X' } }));
    expect(out).toContain('Updated tasklist #9001.');
  });

  it('renders a name change', () => {
    const out = renderTasklistsEditHuman(data({ applied_changes: { name: 'QA checklist' } }));
    expect(out).toContain('name: QA checklist');
  });

  it('renders a budget with the minor-units reminder', () => {
    const out = renderTasklistsEditHuman(data({ applied_changes: { budget: '100000' } }));
    expect(out).toContain('budget: 100000');
    expect(out).toContain('1000.00');
  });

  it('renders a cleared budget as "cleared", not as null', () => {
    const out = renderTasklistsEditHuman(data({ applied_changes: { budget: null } }));
    expect(out).toContain('budget: cleared');
    expect(out).not.toContain('null');
  });

  it('renders a time budget in minutes', () => {
    const out = renderTasklistsEditHuman(data({ applied_changes: { time_budget_minutes: 480 } }));
    expect(out).toContain('time budget: 480 min');
  });

  it('renders time budget 0 as a real value, not as cleared', () => {
    const out = renderTasklistsEditHuman(data({ applied_changes: { time_budget_minutes: 0 } }));
    expect(out).toContain('time budget: 0 min');
    expect(out).not.toContain('time budget: cleared');
  });

  it('renders a cleared time budget', () => {
    const out = renderTasklistsEditHuman(data({ applied_changes: { time_budget_minutes: null } }));
    expect(out).toContain('time budget: cleared');
  });

  it('renders a default worker', () => {
    const out = renderTasklistsEditHuman(data({ applied_changes: { worker_id: 77 } }));
    expect(out).toContain('default worker: #77');
  });

  it('renders a cleared default worker', () => {
    const out = renderTasklistsEditHuman(data({ applied_changes: { worker_id: null } }));
    expect(out).toContain('default worker: cleared');
  });

  it('renders a follower list', () => {
    const out = renderTasklistsEditHuman(
      data({ applied_changes: { tracking_users_ids: [12, 34] } }),
    );
    expect(out).toContain('followers: #12, #34');
  });

  it('renders an empty follower list as an explicit removal', () => {
    const out = renderTasklistsEditHuman(data({ applied_changes: { tracking_users_ids: [] } }));
    expect(out).toContain('followers: cleared (all removed)');
  });

  it('calls out the propagation blast radius', () => {
    const out = renderTasklistsEditHuman(
      data({ applied_changes: { tracking_users_ids: [], should_change_existing_tasks: true } }),
    );
    expect(out).toContain('EVERY existing task');
  });

  it('renders priority as ordering, never as importance', () => {
    const out = renderTasklistsEditHuman(
      data({ priority_requested: true, applied_changes: { priority: 3 } }),
    );
    expect(out).toContain('position in project: 3');
    expect(out).toContain('ordering, not importance');
  });

  it('renders every field together in one block', () => {
    const out = renderTasklistsEditHuman(
      data({
        priority_requested: true,
        applied_changes: {
          name: 'Sprint 12',
          budget: '100000',
          time_budget_minutes: 480,
          worker_id: 77,
          tracking_users_ids: [12],
          should_change_existing_tasks: true,
          priority: 1,
        },
      }),
    );
    for (const fragment of [
      'name: Sprint 12',
      'budget: 100000',
      'time budget: 480 min',
      'default worker: #77',
      'followers: #12',
      'EVERY existing task',
      'position in project: 1',
    ]) {
      expect(out).toContain(fragment);
    }
  });
});

describe('renderTasklistsEditHuman — partial success warning', () => {
  it('warns loudly when a requested reorder was not applied', () => {
    const out = renderTasklistsEditHuman(
      data({
        priority_requested: true,
        priority_applied: false,
        applied_changes: { name: 'Renamed', priority: 3 },
      }),
    );
    expect(out).toContain('PRIORITY NOT APPLIED');
    expect(out).toContain('every other field was saved');
    // Must name the exact retry command, priority only.
    expect(out).toContain('freelo tasklists edit 9001 --priority 3');
  });

  it('does NOT warn when the reorder succeeded', () => {
    const out = renderTasklistsEditHuman(
      data({ priority_requested: true, priority_applied: true, applied_changes: { priority: 1 } }),
    );
    expect(out).not.toContain('PRIORITY NOT APPLIED');
  });

  it('does NOT warn when no reorder was requested, even if the flag is false', () => {
    const out = renderTasklistsEditHuman(
      data({
        priority_requested: false,
        priority_applied: false,
        applied_changes: { name: 'Renamed' },
      }),
    );
    expect(out).not.toContain('PRIORITY NOT APPLIED');
  });

  it('falls back to a placeholder when priority is somehow absent from the body', () => {
    const out = renderTasklistsEditHuman(
      data({ priority_requested: true, priority_applied: false, applied_changes: {} }),
    );
    expect(out).toContain('--priority <n>');
  });
});

describe('renderTasklistsEditHuman — dry-run', () => {
  it('renders the would-update headline and the change lines from would.body', () => {
    const out = renderTasklistsEditHuman(
      data({
        applied_changes: { name: 'Preview', budget: null },
        would: {
          method: 'POST',
          path: '/tasklist/9001/edit',
          body: { name: 'Preview', budget: null },
        },
      }),
    );
    expect(out).toContain('(dry-run) Would update tasklist #9001.');
    expect(out).toContain('name: Preview');
    expect(out).toContain('budget: cleared');
  });

  it('never emits the priority warning on a dry-run (no call was made)', () => {
    const out = renderTasklistsEditHuman(
      data({
        priority_requested: true,
        priority_applied: false,
        applied_changes: { priority: 2 },
        would: { method: 'POST', path: '/tasklist/9001/edit', body: { priority: 2 } },
      }),
    );
    expect(out).not.toContain('PRIORITY NOT APPLIED');
    expect(out).toContain('(dry-run)');
  });
});
