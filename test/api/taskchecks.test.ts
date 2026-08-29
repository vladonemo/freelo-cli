/**
 * Unit tests for the pure helpers in `src/api/taskchecks.ts` (M03, spec 0066).
 *
 * No MSW, no I/O — these prove the wire-body contract in isolation, which is
 * where the decision-3 asymmetry (`notify_author` on `edit`/`finish` only) and
 * the `worker: null` clear semantics are cheapest to pin.
 */

import { describe, expect, it } from 'vitest';
import {
  buildEditTaskcheckBody,
  deleteTaskcheckPath,
  editTaskcheckPath,
  isEmptyEditTaskcheckBody,
  transitionTaskcheckPath,
} from '../../src/api/taskchecks.js';
import { renderTaskchecksEditHuman } from '../../src/ui/human/taskchecks-edit.js';
import { renderTaskchecksDeleteHuman } from '../../src/ui/human/taskchecks-delete.js';
import {
  renderTaskchecksBatchFailureHuman,
  renderTaskchecksTransitionHuman,
} from '../../src/ui/human/taskchecks-transition.js';

describe('taskcheck path builders', () => {
  it('edit and delete share the bare /taskcheck/{id} path', () => {
    expect(editTaskcheckPath(4821)).toBe('/taskcheck/4821');
    expect(deleteTaskcheckPath(4821)).toBe('/taskcheck/4821');
  });

  it('reopen maps to the wire verb /activate, not /reopen', () => {
    expect(transitionTaskcheckPath(4821, 'finish')).toBe('/taskcheck/4821/finish');
    expect(transitionTaskcheckPath(4821, 'reopen')).toBe('/taskcheck/4821/activate');
  });
});

describe('buildEditTaskcheckBody', () => {
  it('emits only the keys the user set', () => {
    expect(buildEditTaskcheckBody({ name: 'Rewrite intro' })).toEqual({ name: 'Rewrite intro' });
  });

  it('--worker emits the numeric id', () => {
    expect(buildEditTaskcheckBody({ worker: 7 })).toEqual({ worker: 7 });
  });

  it('--clear-worker emits worker: null, the documented clearing value (yaml :2140)', () => {
    expect(buildEditTaskcheckBody({ clearWorker: true })).toEqual({ worker: null });
  });

  it('explicit worker wins over clearWorker so the builder stays total', () => {
    expect(buildEditTaskcheckBody({ worker: 7, clearWorker: true })).toEqual({ worker: 7 });
  });

  it('notify_author is emitted only when true — false is the server default', () => {
    expect(buildEditTaskcheckBody({ name: 'x' })).not.toHaveProperty('notify_author');
    expect(buildEditTaskcheckBody({ name: 'x', notifyAuthor: true })).toEqual({
      name: 'x',
      notify_author: true,
    });
  });

  it('never emits priority / due_date — they are 400 on this endpoint (yaml :2124)', () => {
    const body = buildEditTaskcheckBody({ name: 'x', worker: 7, notifyAuthor: true });
    expect(Object.keys(body).sort()).toEqual(['name', 'notify_author', 'worker']);
  });
});

describe('isEmptyEditTaskcheckBody', () => {
  it('an empty body is empty', () => {
    expect(isEmptyEditTaskcheckBody({})).toBe(true);
  });

  it('notify_author alone is NOT a mutating change', () => {
    expect(isEmptyEditTaskcheckBody({ notify_author: true })).toBe(true);
  });

  it('name or worker makes it non-empty', () => {
    expect(isEmptyEditTaskcheckBody({ name: 'x' })).toBe(false);
    expect(isEmptyEditTaskcheckBody({ worker: 7 })).toBe(false);
    expect(isEmptyEditTaskcheckBody({ worker: null })).toBe(false);
  });
});

describe('human renderers', () => {
  it('edit: live vs dry-run, with the applied-changes list', () => {
    expect(
      renderTaskchecksEditHuman({
        taskcheck_id: 4821,
        applied_changes: ['name', 'worker'],
        notify_author: false,
      }),
    ).toBe('Edited taskcheck 4821 (name, worker).');

    expect(
      renderTaskchecksEditHuman({
        taskcheck_id: 4821,
        applied_changes: ['clear_worker'],
        notify_author: false,
        would: { method: 'POST', path: '/taskcheck/4821', body: { worker: null } },
      }),
    ).toBe('(dry-run) Would edit taskcheck 4821 (cleared worker).');
  });

  it('edit: an empty applied_changes list renders without the parenthetical', () => {
    // Unreachable through the CLI (the command refuses an empty edit), but the
    // renderer stays total rather than emitting a stray " ()".
    expect(
      renderTaskchecksEditHuman({
        taskcheck_id: 4821,
        applied_changes: [],
        notify_author: false,
      }),
    ).toBe('Edited taskcheck 4821.');
  });

  it('delete: live vs dry-run, and no "already deleted" shape exists', () => {
    expect(renderTaskchecksDeleteHuman({ taskcheck_id: 4821, current_state: 'deleted' })).toBe(
      'Deleted taskcheck 4821.',
    );
    expect(
      renderTaskchecksDeleteHuman({
        taskcheck_id: 4821,
        current_state: 'deleted',
        would: { method: 'DELETE', path: '/taskcheck/4821', body: {} },
      }),
    ).toBe('(dry-run) Would delete taskcheck 4821.');
  });

  it('transition: finish vs reopen wording, live vs dry-run', () => {
    expect(
      renderTaskchecksTransitionHuman({
        taskcheck_id: 4821,
        verb: 'finish',
        current_state: 'finished',
        notify_author: false,
      }),
    ).toBe('Finished taskcheck 4821.');

    expect(
      renderTaskchecksTransitionHuman({
        taskcheck_id: 4821,
        verb: 'reopen',
        current_state: 'active',
        notify_author: false,
      }),
    ).toBe('Reopened taskcheck 4821.');

    expect(
      renderTaskchecksTransitionHuman({
        taskcheck_id: 4821,
        verb: 'finish',
        current_state: 'finished',
        notify_author: false,
        would: { method: 'POST', path: '/taskcheck/4821/finish', body: {} },
      }),
    ).toBe('(dry-run) Would finish taskcheck 4821.');
  });

  it('batch failure line includes the id when the item parsed', () => {
    expect(renderTaskchecksBatchFailureHuman(1, 4822, 'boom')).toBe('Failed item 2 (4822): boom');
    expect(renderTaskchecksBatchFailureHuman(0, null, 'bad line')).toBe('Failed item 1: bad line');
  });
});
