/**
 * Unit tests for `src/api/notes.ts` (R44 spec 0058).
 *
 * Covers the wire shape (path + method) plus the `signal` / `requestId`
 * opt-spread branches that command tests never hit. Mandatory per
 * `.claude/docs/conventions.md` §Tests (calibration §4).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildCreateNoteBody,
  buildEditNoteBody,
  createNote,
  createNotePath,
  deleteNote,
  editNote,
  getNote,
  notePath,
} from '../../src/api/notes.js';
import type { HttpClient } from '../../src/api/client.js';

function fakeClient(data: unknown): HttpClient & { calls: Array<Record<string, unknown>> } {
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

const sampleNote = {
  id: 1234,
  name: 'Meeting minutes',
  content: 'Body',
  date_add: '2026-05-10T00:00:00Z',
  date_edited_at: '2026-05-10T00:00:00Z',
};

describe('notes path helpers', () => {
  it('createNotePath formats /project/<id>/note', () => {
    expect(createNotePath(100)).toBe('/project/100/note');
  });

  it('notePath formats /note/<id>', () => {
    expect(notePath(1234)).toBe('/note/1234');
  });
});

describe('buildCreateNoteBody', () => {
  it('emits name only when content is omitted', () => {
    expect(buildCreateNoteBody({ name: 'Title' })).toEqual({ name: 'Title' });
  });

  it('emits name + content when content is supplied', () => {
    expect(buildCreateNoteBody({ name: 'Title', content: 'Body' })).toEqual({
      name: 'Title',
      content: 'Body',
    });
  });
});

describe('buildEditNoteBody', () => {
  it('emits name only when content is omitted', () => {
    expect(buildEditNoteBody({ name: 'New Title' })).toEqual({ name: 'New Title' });
  });

  it('emits name + content when both supplied', () => {
    expect(buildEditNoteBody({ name: 'New', content: 'Body' })).toEqual({
      name: 'New',
      content: 'Body',
    });
  });
});

describe('createNote', () => {
  it('POSTs to /project/<id>/note with the body', async () => {
    const client = fakeClient(sampleNote);
    await createNote(client, 100, { name: 'Title', content: 'Body' });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!['method']).toBe('POST');
    expect(client.calls[0]!['path']).toBe('/project/100/note');
    expect(client.calls[0]!['body']).toEqual({ name: 'Title', content: 'Body' });
  });

  it('does not include signal / requestId when absent (covers absent-spread branches)', async () => {
    const client = fakeClient(sampleNote);
    await createNote(client, 100, { name: 'Title' });
    expect(client.calls[0]).not.toHaveProperty('signal');
    expect(client.calls[0]).not.toHaveProperty('requestId');
  });

  it('threads through opts.signal when provided (covers signal-spread branch)', async () => {
    const client = fakeClient(sampleNote);
    const ac = new AbortController();
    await createNote(client, 100, { name: 'Title' }, { signal: ac.signal });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
  });

  it('threads through opts.requestId when provided (covers requestId-spread branch)', async () => {
    const client = fakeClient(sampleNote);
    await createNote(client, 100, { name: 'Title' }, { requestId: 'req-create' });
    expect(client.calls[0]!['requestId']).toBe('req-create');
  });

  it('returns parsed body and raw response', async () => {
    const client = fakeClient(sampleNote);
    const result = await createNote(client, 100, { name: 'Title' });
    expect(result.body.id).toBe(1234);
    expect(result.body.name).toBe('Meeting minutes');
    expect(result.raw.data.id).toBe(1234);
  });
});

describe('getNote', () => {
  it('GETs /note/<id>', async () => {
    const client = fakeClient(sampleNote);
    await getNote(client, 1234);
    expect(client.calls[0]!['method']).toBe('GET');
    expect(client.calls[0]!['path']).toBe('/note/1234');
  });

  it('does not include signal / requestId when absent', async () => {
    const client = fakeClient(sampleNote);
    await getNote(client, 1234);
    expect(client.calls[0]).not.toHaveProperty('signal');
    expect(client.calls[0]).not.toHaveProperty('requestId');
  });

  it('threads opts.signal', async () => {
    const client = fakeClient(sampleNote);
    const ac = new AbortController();
    await getNote(client, 1234, { signal: ac.signal });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
  });

  it('threads opts.requestId', async () => {
    const client = fakeClient(sampleNote);
    await getNote(client, 1234, { requestId: 'req-get' });
    expect(client.calls[0]!['requestId']).toBe('req-get');
  });
});

describe('editNote', () => {
  it('POSTs /note/<id> with the body (verb is POST per yaml :4625, NOT PATCH)', async () => {
    const client = fakeClient(sampleNote);
    await editNote(client, 1234, { name: 'New', content: 'Body' });
    expect(client.calls[0]!['method']).toBe('POST');
    expect(client.calls[0]!['path']).toBe('/note/1234');
    expect(client.calls[0]!['body']).toEqual({ name: 'New', content: 'Body' });
  });

  it('does not include signal / requestId when absent', async () => {
    const client = fakeClient(sampleNote);
    await editNote(client, 1234, { name: 'New' });
    expect(client.calls[0]).not.toHaveProperty('signal');
    expect(client.calls[0]).not.toHaveProperty('requestId');
  });

  it('threads opts.signal', async () => {
    const client = fakeClient(sampleNote);
    const ac = new AbortController();
    await editNote(client, 1234, { name: 'New' }, { signal: ac.signal });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
  });

  it('threads opts.requestId', async () => {
    const client = fakeClient(sampleNote);
    await editNote(client, 1234, { name: 'New' }, { requestId: 'req-edit' });
    expect(client.calls[0]!['requestId']).toBe('req-edit');
  });
});

describe('deleteNote', () => {
  it('DELETEs /note/<id> and parses the returned Note (API quirk per yaml :4669)', async () => {
    const client = fakeClient(sampleNote);
    const result = await deleteNote(client, 1234);
    expect(client.calls[0]!['method']).toBe('DELETE');
    expect(client.calls[0]!['path']).toBe('/note/1234');
    // The DELETE response is the deleted Note's last state, not a SuccessResponse.
    expect(result.body.id).toBe(1234);
    expect(result.body.name).toBe('Meeting minutes');
  });

  it('does not include signal / requestId when absent', async () => {
    const client = fakeClient(sampleNote);
    await deleteNote(client, 1234);
    expect(client.calls[0]).not.toHaveProperty('signal');
    expect(client.calls[0]).not.toHaveProperty('requestId');
  });

  it('threads opts.signal', async () => {
    const client = fakeClient(sampleNote);
    const ac = new AbortController();
    await deleteNote(client, 1234, { signal: ac.signal });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
  });

  it('threads opts.requestId', async () => {
    const client = fakeClient(sampleNote);
    await deleteNote(client, 1234, { requestId: 'req-delete' });
    expect(client.calls[0]!['requestId']).toBe('req-delete');
  });
});
