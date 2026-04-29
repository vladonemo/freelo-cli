/**
 * Unit tests for `src/api/task-labels.ts` (R24, spec 0036).
 *
 * Pure-function tests — no MSW for the builders. The wire-call wrappers
 * use MSW + the real `createHttpClient` to exercise the optional-spread
 * branches for `signal` / `requestId` (lines 169-170, 198-199, 229-230 —
 * keeps `src/api/**` branch coverage above the 80% threshold).
 */

import { describe, expect, it } from 'vitest';
import { createHttpClient } from '../../src/api/client.js';
import {
  TASK_LABELS_PATH,
  addTaskLabelsPath,
  removeTaskLabelsPath,
  buildCreateTaskLabelsBody,
  buildAddTaskLabelsBody,
  buildRemoveTaskLabelsBody,
  createTaskLabels,
  addTaskLabelsToTask,
  removeTaskLabelsFromTask,
} from '../../src/api/task-labels.js';
import { server, taskLabelsHandlers, API_BASE } from '../msw/handlers.js';

function makeClient() {
  return createHttpClient({
    email: 'agent@example.com',
    apiKey: 'sk-test',
    apiBaseUrl: API_BASE,
    userAgent: 'freelo-cli-test/0.0.0',
  });
}

describe('task-labels path helpers', () => {
  it('TASK_LABELS_PATH is /task-labels', () => {
    expect(TASK_LABELS_PATH).toBe('/task-labels');
  });

  it('addTaskLabelsPath formats /task-labels/add-to-task/<id>', () => {
    expect(addTaskLabelsPath(7)).toBe('/task-labels/add-to-task/7');
  });

  it('removeTaskLabelsPath formats /task-labels/remove-from-task/<id>', () => {
    expect(removeTaskLabelsPath(7)).toBe('/task-labels/remove-from-task/7');
  });
});

describe('buildCreateTaskLabelsBody', () => {
  it('emits one entry per name with no color when none supplied', () => {
    const body = buildCreateTaskLabelsBody({ names: ['Bug', 'Wip'] });
    expect(body).toEqual({
      labels: [{ name: 'Bug' }, { name: 'Wip' }],
    });
  });

  it('applies a single color to every name (decision 04)', () => {
    const body = buildCreateTaskLabelsBody({
      names: ['Bug', 'Wip'],
      color: '#9b59b6',
    });
    expect(body).toEqual({
      labels: [
        { name: 'Bug', color: '#9b59b6' },
        { name: 'Wip', color: '#9b59b6' },
      ],
    });
  });

  it('emits an empty labels array when no names supplied', () => {
    const body = buildCreateTaskLabelsBody({ names: [] });
    expect(body).toEqual({ labels: [] });
  });
});

describe('buildAddTaskLabelsBody', () => {
  it('uuid-only entry has just `uuid`', () => {
    const body = buildAddTaskLabelsBody({
      uuids: ['11111111-1111-1111-1111-111111111111'],
      names: [],
    });
    expect(body.labels).toHaveLength(1);
    expect(body.labels[0]).toEqual({ uuid: '11111111-1111-1111-1111-111111111111' });
  });

  it('name-only entry has just `name`', () => {
    const body = buildAddTaskLabelsBody({ uuids: [], names: ['Bug'] });
    expect(body.labels).toHaveLength(1);
    expect(body.labels[0]).toEqual({ name: 'Bug' });
  });

  it('mixes uuid + name entries; uuid entries come first', () => {
    const body = buildAddTaskLabelsBody({
      uuids: ['11111111-1111-1111-1111-111111111111'],
      names: ['Bug', 'Wip'],
      color: '#abcdef',
    });
    expect(body.labels).toHaveLength(3);
    expect(body.labels[0]).toEqual({ uuid: '11111111-1111-1111-1111-111111111111' });
    expect(body.labels[1]).toEqual({ name: 'Bug', color: '#abcdef' });
    expect(body.labels[2]).toEqual({ name: 'Wip', color: '#abcdef' });
  });

  it('color does not pollute uuid-mode entries', () => {
    const body = buildAddTaskLabelsBody({
      uuids: ['11111111-1111-1111-1111-111111111111'],
      names: [],
      color: '#abcdef',
    });
    expect(body.labels[0]).not.toHaveProperty('color');
  });

  it('omits color from name entry when not supplied (server default applies)', () => {
    const body = buildAddTaskLabelsBody({ uuids: [], names: ['Bug'] });
    expect(body.labels[0]).not.toHaveProperty('color');
  });
});

describe('buildRemoveTaskLabelsBody', () => {
  it('uuid-only entry: just `uuid`', () => {
    const body = buildRemoveTaskLabelsBody({
      uuids: ['11111111-1111-1111-1111-111111111111'],
      names: [],
    });
    expect(body.labels[0]).toEqual({ uuid: '11111111-1111-1111-1111-111111111111' });
  });

  it('name-only entry: just `name` (no color → aggressive any-color removal)', () => {
    const body = buildRemoveTaskLabelsBody({ uuids: [], names: ['Bug'] });
    expect(body.labels[0]).toEqual({ name: 'Bug' });
    expect(body.labels[0]).not.toHaveProperty('color');
  });

  it('name+color entry when color is supplied (precise removal)', () => {
    const body = buildRemoveTaskLabelsBody({
      uuids: [],
      names: ['Bug'],
      color: '#abcdef',
    });
    expect(body.labels[0]).toEqual({ name: 'Bug', color: '#abcdef' });
  });

  it('color upgrades all name entries; uuid entries unchanged', () => {
    const body = buildRemoveTaskLabelsBody({
      uuids: ['11111111-1111-1111-1111-111111111111'],
      names: ['Bug', 'Wip'],
      color: '#abcdef',
    });
    expect(body.labels).toHaveLength(3);
    expect(body.labels[0]).toEqual({ uuid: '11111111-1111-1111-1111-111111111111' });
    expect(body.labels[1]).toEqual({ name: 'Bug', color: '#abcdef' });
    expect(body.labels[2]).toEqual({ name: 'Wip', color: '#abcdef' });
  });
});

/**
 * Wire-call wrapper tests — exercise the optional-spread truthy arms for
 * `signal` and `requestId` in each of the three POST functions. Without
 * these the `src/api/**` branch coverage drops below the 80% gate.
 *
 * Mirror of the pattern in `test/api/tasklists-show.test.ts:75-94`.
 */
describe('createTaskLabels — signal/requestId branches', () => {
  it('honours an explicit signal (covers the signal-set branch)', async () => {
    server.use(taskLabelsHandlers.createOk());
    const controller = new AbortController();
    const out = await createTaskLabels(makeClient(), {
      body: { labels: [{ name: 'Bug' }] },
      signal: controller.signal,
    });
    expect(out.raw.data).toEqual(expect.objectContaining({ result: 'success' }));
  });

  it('honours an explicit requestId (covers the requestId-set branch)', async () => {
    server.use(taskLabelsHandlers.createOk());
    const out = await createTaskLabels(makeClient(), {
      body: { labels: [{ name: 'Bug' }] },
      requestId: '11111111-2222-4333-8444-555555555555',
    });
    expect(out.raw.data).toEqual(expect.objectContaining({ result: 'success' }));
  });
});

describe('addTaskLabelsToTask — signal/requestId branches', () => {
  it('honours an explicit signal (covers the signal-set branch)', async () => {
    server.use(taskLabelsHandlers.attachOk());
    const controller = new AbortController();
    const out = await addTaskLabelsToTask(makeClient(), 7, {
      body: { labels: [{ name: 'Bug' }] },
      signal: controller.signal,
    });
    expect(out.raw.data).toEqual(expect.objectContaining({ result: 'success' }));
  });

  it('honours an explicit requestId (covers the requestId-set branch)', async () => {
    server.use(taskLabelsHandlers.attachOk());
    const out = await addTaskLabelsToTask(makeClient(), 7, {
      body: { labels: [{ name: 'Bug' }] },
      requestId: '11111111-2222-4333-8444-555555555555',
    });
    expect(out.raw.data).toEqual(expect.objectContaining({ result: 'success' }));
  });
});

describe('removeTaskLabelsFromTask — signal/requestId branches', () => {
  it('honours an explicit signal (covers the signal-set branch)', async () => {
    server.use(taskLabelsHandlers.detachOk());
    const controller = new AbortController();
    const out = await removeTaskLabelsFromTask(makeClient(), 7, {
      body: { labels: [{ name: 'Bug' }] },
      signal: controller.signal,
    });
    expect(out.raw.data).toEqual(expect.objectContaining({ result: 'success' }));
  });

  it('honours an explicit requestId (covers the requestId-set branch)', async () => {
    server.use(taskLabelsHandlers.detachOk());
    const out = await removeTaskLabelsFromTask(makeClient(), 7, {
      body: { labels: [{ name: 'Bug' }] },
      requestId: '11111111-2222-4333-8444-555555555555',
    });
    expect(out.raw.data).toEqual(expect.objectContaining({ result: 'success' }));
  });
});
