/**
 * Unit tests for `src/api/custom-fields.ts` (R40 spec 0054).
 *
 * Mirrors `tasks-relations.test.ts` / `tasks-projects.test.ts`: covers the
 * wire shape (path + method) plus the `signal` / `requestId` opt-spread
 * branches that command tests never hit. Mandatory per
 * `.claude/docs/conventions.md` §Tests (calibration §4 from PR #96).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildCreateCustomFieldBody,
  createCustomField,
  createCustomFieldPath,
  deleteCustomField,
  deleteCustomFieldPath,
  findCustomFieldsByProject,
  findCustomFieldsByProjectPath,
  getCustomFieldTypes,
  getCustomFieldTypesPath,
  renameCustomField,
  renameCustomFieldPath,
  restoreCustomField,
  restoreCustomFieldPath,
} from '../../src/api/custom-fields.js';
import type { HttpClient } from '../../src/api/client.js';

describe('custom-fields path helpers', () => {
  it('getCustomFieldTypesPath is the constant /custom-field/get-types', () => {
    expect(getCustomFieldTypesPath()).toBe('/custom-field/get-types');
  });

  it('findCustomFieldsByProjectPath formats /custom-field/find-by-project/<id>', () => {
    expect(findCustomFieldsByProjectPath(100)).toBe('/custom-field/find-by-project/100');
  });
});

describe('getCustomFieldTypes', () => {
  it('GETs the type catalog path', async () => {
    const client = fakeClient({ custom_field_types: [] });
    await getCustomFieldTypes(client);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!['method']).toBe('GET');
    expect(client.calls[0]!['path']).toBe('/custom-field/get-types');
  });

  it('does not include signal / requestId in opts when absent (covers absent-spread branches)', async () => {
    const client = fakeClient({ custom_field_types: [] });
    await getCustomFieldTypes(client);
    expect(client.calls[0]).not.toHaveProperty('signal');
    expect(client.calls[0]).not.toHaveProperty('requestId');
  });

  it('threads through opts.signal when provided (covers signal-spread branch)', async () => {
    const client = fakeClient({ custom_field_types: [] });
    const ac = new AbortController();
    await getCustomFieldTypes(client, { signal: ac.signal });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
  });

  it('threads through opts.requestId when provided (covers requestId-spread branch)', async () => {
    const client = fakeClient({ custom_field_types: [] });
    await getCustomFieldTypes(client, { requestId: 'req-cf-types' });
    expect(client.calls[0]!['requestId']).toBe('req-cf-types');
  });

  it('returns parsed body and raw response', async () => {
    const types = [
      { uuid: '2f7bfe3a-c950-470e-b910-95b4caf5dc4f', name: 'text' },
      { uuid: 'b1e56fa9-a97a-429b-8ab4-82bebe58933a', name: 'number' },
    ];
    const client = fakeClient({ custom_field_types: types });
    const result = await getCustomFieldTypes(client);
    expect(result.body.custom_field_types).toEqual(types);
    expect(result.raw.data.custom_field_types).toEqual(types);
  });
});

describe('findCustomFieldsByProject', () => {
  it('GETs /custom-field/find-by-project/<id>', async () => {
    const client = fakeClient({ custom_fields: [], is_commander: false });
    await findCustomFieldsByProject(client, 100);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!['method']).toBe('GET');
    expect(client.calls[0]!['path']).toBe('/custom-field/find-by-project/100');
  });

  it('does not include signal / requestId in opts when absent', async () => {
    const client = fakeClient({ custom_fields: [], is_commander: false });
    await findCustomFieldsByProject(client, 100);
    expect(client.calls[0]).not.toHaveProperty('signal');
    expect(client.calls[0]).not.toHaveProperty('requestId');
  });

  it('threads through opts.signal when provided (covers signal-spread branch)', async () => {
    const client = fakeClient({ custom_fields: [], is_commander: false });
    const ac = new AbortController();
    await findCustomFieldsByProject(client, 100, { signal: ac.signal });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
  });

  it('threads through opts.requestId when provided (covers requestId-spread branch)', async () => {
    const client = fakeClient({ custom_fields: [], is_commander: false });
    await findCustomFieldsByProject(client, 100, { requestId: 'req-cf-list' });
    expect(client.calls[0]!['requestId']).toBe('req-cf-list');
  });

  it('returns parsed body and raw response with is_commander', async () => {
    const fields = [
      {
        uuid: '11111111-1111-1111-1111-111111111111',
        name: 'Severity',
        custom_fields_types_uuid: '2f7bfe3a-c950-470e-b910-95b4caf5dc4f',
        project_id: 100,
        author_id: 5,
        date_add: '2025-01-01T00:00:00Z',
        priority: 1,
      },
    ];
    const client = fakeClient({ custom_fields: fields, is_commander: true });
    const result = await findCustomFieldsByProject(client, 100);
    expect(result.body.custom_fields).toEqual(fields);
    expect(result.body.is_commander).toBe(true);
  });
});

function fakeClient(data: unknown): HttpClient & {
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const request = vi.fn((opts: Record<string, unknown>) => {
    calls.push(opts);
    return Promise.resolve({
      data,
      rateLimit: { remaining: 99, resetAt: '2026-05-10T00:00:00Z' },
      requestId: 'req-fake',
    });
  });
  return Object.assign({ request, calls }, { calls }) as unknown as HttpClient & {
    calls: Array<Record<string, unknown>>;
  };
}

/* ===========================================================================
 *  R41 — CRUD wire wrappers (spec 0055).
 *
 *  Each wrapper uses the conditional `signal` / `requestId` opt-spread.
 *  `exactOptionalPropertyTypes` means each spread is two branches; we
 *  assert both per wrapper. Calibration §4 mandates this — command-level
 *  tests never hit the present-branch.
 * ========================================================================= */

const FIELD_UUID = '11111111-1111-1111-1111-111111111111';
const TYPE_UUID = '2f7bfe3a-c950-470e-b910-95b4caf5dc4f';

const sampleCustomField = {
  uuid: FIELD_UUID,
  name: 'Severity',
  custom_fields_types_uuid: TYPE_UUID,
  project_id: 100,
  author_id: 5,
  date_add: '2026-05-10T00:00:00Z',
  priority: 1,
};

describe('R41 path helpers', () => {
  it('createCustomFieldPath formats /custom-field/create/<projectId>', () => {
    expect(createCustomFieldPath(100)).toBe('/custom-field/create/100');
  });

  it('renameCustomFieldPath formats /custom-field/rename/<uuid>', () => {
    expect(renameCustomFieldPath(FIELD_UUID)).toBe(`/custom-field/rename/${FIELD_UUID}`);
  });

  it('deleteCustomFieldPath formats /custom-field/delete/<uuid>', () => {
    expect(deleteCustomFieldPath(FIELD_UUID)).toBe(`/custom-field/delete/${FIELD_UUID}`);
  });

  it('restoreCustomFieldPath formats /custom-field/restore/<uuid>', () => {
    expect(restoreCustomFieldPath(FIELD_UUID)).toBe(`/custom-field/restore/${FIELD_UUID}`);
  });
});

describe('buildCreateCustomFieldBody', () => {
  it('emits required name + type, omits uuid when not supplied', () => {
    const body = buildCreateCustomFieldBody({ name: 'Severity', typeUuid: TYPE_UUID });
    expect(body).toEqual({ name: 'Severity', type: TYPE_UUID });
    expect(body).not.toHaveProperty('uuid');
  });

  it('threads through optional uuid when supplied', () => {
    const body = buildCreateCustomFieldBody({
      name: 'Severity',
      typeUuid: TYPE_UUID,
      uuid: FIELD_UUID,
    });
    expect(body).toEqual({ name: 'Severity', type: TYPE_UUID, uuid: FIELD_UUID });
  });
});

describe('createCustomField', () => {
  it('POSTs /custom-field/create/<projectId> with the body', async () => {
    const client = fakeClient({ custom_field: sampleCustomField });
    await createCustomField(client, 100, {
      body: { name: 'Severity', type: TYPE_UUID },
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!['method']).toBe('POST');
    expect(client.calls[0]!['path']).toBe('/custom-field/create/100');
    expect(client.calls[0]!['body']).toEqual({ name: 'Severity', type: TYPE_UUID });
  });

  it('does not include signal / requestId in opts when absent', async () => {
    const client = fakeClient({ custom_field: sampleCustomField });
    await createCustomField(client, 100, { body: { name: 'X', type: TYPE_UUID } });
    expect(client.calls[0]).not.toHaveProperty('signal');
    expect(client.calls[0]).not.toHaveProperty('requestId');
  });

  it('threads through opts.signal when provided', async () => {
    const client = fakeClient({ custom_field: sampleCustomField });
    const ac = new AbortController();
    await createCustomField(client, 100, {
      body: { name: 'X', type: TYPE_UUID },
      signal: ac.signal,
    });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
  });

  it('threads through opts.requestId when provided', async () => {
    const client = fakeClient({ custom_field: sampleCustomField });
    await createCustomField(client, 100, {
      body: { name: 'X', type: TYPE_UUID },
      requestId: 'req-cf-create',
    });
    expect(client.calls[0]!['requestId']).toBe('req-cf-create');
  });

  it('returns parsed body and raw response', async () => {
    const client = fakeClient({ custom_field: sampleCustomField });
    const result = await createCustomField(client, 100, {
      body: { name: 'Severity', type: TYPE_UUID },
    });
    expect(result.body.custom_field).toEqual(sampleCustomField);
    expect(result.raw.data.custom_field).toEqual(sampleCustomField);
  });
});

describe('renameCustomField', () => {
  it('POSTs /custom-field/rename/<uuid> with { name }', async () => {
    const client = fakeClient({ custom_field: { ...sampleCustomField, name: 'Renamed' } });
    await renameCustomField(client, FIELD_UUID, { body: { name: 'Renamed' } });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!['method']).toBe('POST');
    expect(client.calls[0]!['path']).toBe(`/custom-field/rename/${FIELD_UUID}`);
    expect(client.calls[0]!['body']).toEqual({ name: 'Renamed' });
  });

  it('does not include signal / requestId in opts when absent', async () => {
    const client = fakeClient({ custom_field: sampleCustomField });
    await renameCustomField(client, FIELD_UUID, { body: { name: 'X' } });
    expect(client.calls[0]).not.toHaveProperty('signal');
    expect(client.calls[0]).not.toHaveProperty('requestId');
  });

  it('threads through opts.signal when provided', async () => {
    const client = fakeClient({ custom_field: sampleCustomField });
    const ac = new AbortController();
    await renameCustomField(client, FIELD_UUID, {
      body: { name: 'X' },
      signal: ac.signal,
    });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
  });

  it('threads through opts.requestId when provided', async () => {
    const client = fakeClient({ custom_field: sampleCustomField });
    await renameCustomField(client, FIELD_UUID, {
      body: { name: 'X' },
      requestId: 'req-cf-rename',
    });
    expect(client.calls[0]!['requestId']).toBe('req-cf-rename');
  });
});

describe('deleteCustomField', () => {
  it('DELETEs /custom-field/delete/<uuid>', async () => {
    const client = fakeClient({ result: 'success' });
    await deleteCustomField(client, FIELD_UUID);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!['method']).toBe('DELETE');
    expect(client.calls[0]!['path']).toBe(`/custom-field/delete/${FIELD_UUID}`);
  });

  it('does not include signal / requestId in opts when absent', async () => {
    const client = fakeClient({ result: 'success' });
    await deleteCustomField(client, FIELD_UUID);
    expect(client.calls[0]).not.toHaveProperty('signal');
    expect(client.calls[0]).not.toHaveProperty('requestId');
  });

  it('threads through opts.signal when provided', async () => {
    const client = fakeClient({ result: 'success' });
    const ac = new AbortController();
    await deleteCustomField(client, FIELD_UUID, { signal: ac.signal });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
  });

  it('threads through opts.requestId when provided', async () => {
    const client = fakeClient({ result: 'success' });
    await deleteCustomField(client, FIELD_UUID, { requestId: 'req-cf-delete' });
    expect(client.calls[0]!['requestId']).toBe('req-cf-delete');
  });
});

describe('restoreCustomField', () => {
  it('POSTs /custom-field/restore/<uuid>', async () => {
    const client = fakeClient({ custom_field: sampleCustomField });
    await restoreCustomField(client, FIELD_UUID);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!['method']).toBe('POST');
    expect(client.calls[0]!['path']).toBe(`/custom-field/restore/${FIELD_UUID}`);
  });

  it('does not include signal / requestId in opts when absent', async () => {
    const client = fakeClient({ custom_field: sampleCustomField });
    await restoreCustomField(client, FIELD_UUID);
    expect(client.calls[0]).not.toHaveProperty('signal');
    expect(client.calls[0]).not.toHaveProperty('requestId');
  });

  it('threads through opts.signal when provided', async () => {
    const client = fakeClient({ custom_field: sampleCustomField });
    const ac = new AbortController();
    await restoreCustomField(client, FIELD_UUID, { signal: ac.signal });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
  });

  it('threads through opts.requestId when provided', async () => {
    const client = fakeClient({ custom_field: sampleCustomField });
    await restoreCustomField(client, FIELD_UUID, { requestId: 'req-cf-restore' });
    expect(client.calls[0]!['requestId']).toBe('req-cf-restore');
  });

  it('returns parsed body with custom_field', async () => {
    const client = fakeClient({ custom_field: sampleCustomField });
    const result = await restoreCustomField(client, FIELD_UUID);
    expect(result.body.custom_field).toEqual(sampleCustomField);
  });
});
