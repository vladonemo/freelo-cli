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
  findCustomFieldsByProject,
  findCustomFieldsByProjectPath,
  getCustomFieldTypes,
  getCustomFieldTypesPath,
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
