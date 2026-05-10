/**
 * Unit tests for `src/api/pins.ts` (R44 spec 0058).
 *
 * Covers the wire shape (path + method) plus the `signal` / `requestId`
 * opt-spread branches that command tests never hit. Mandatory per
 * `.claude/docs/conventions.md` §Tests (calibration §4).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildPinItemBody,
  deletePinnedItem,
  getPinnedItems,
  pinItem,
  pinnedItemPath,
  pinnedItemsPath,
} from '../../src/api/pins.js';
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

const samplePin = { id: 99, link: 'https://example.com/spec', title: 'Spec doc' };

describe('pins path helpers', () => {
  it('pinnedItemsPath formats /project/<id>/pinned-items', () => {
    expect(pinnedItemsPath(100)).toBe('/project/100/pinned-items');
  });

  it('pinnedItemPath formats /pinned-item/<id>', () => {
    expect(pinnedItemPath(99)).toBe('/pinned-item/99');
  });
});

describe('buildPinItemBody', () => {
  it('emits link only when title is omitted', () => {
    expect(buildPinItemBody({ link: 'https://x' })).toEqual({ link: 'https://x' });
  });

  it('emits link + title when both supplied', () => {
    expect(buildPinItemBody({ link: 'https://x', title: 'X' })).toEqual({
      link: 'https://x',
      title: 'X',
    });
  });
});

describe('getPinnedItems', () => {
  it('GETs /project/<id>/pinned-items', async () => {
    const client = fakeClient([samplePin]);
    await getPinnedItems(client, 100);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!['method']).toBe('GET');
    expect(client.calls[0]!['path']).toBe('/project/100/pinned-items');
  });

  it('does not include signal / requestId when absent', async () => {
    const client = fakeClient([]);
    await getPinnedItems(client, 100);
    expect(client.calls[0]).not.toHaveProperty('signal');
    expect(client.calls[0]).not.toHaveProperty('requestId');
  });

  it('threads opts.signal', async () => {
    const client = fakeClient([]);
    const ac = new AbortController();
    await getPinnedItems(client, 100, { signal: ac.signal });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
  });

  it('threads opts.requestId', async () => {
    const client = fakeClient([]);
    await getPinnedItems(client, 100, { requestId: 'req-list' });
    expect(client.calls[0]!['requestId']).toBe('req-list');
  });

  it('returns the parsed flat array as body', async () => {
    const client = fakeClient([samplePin]);
    const result = await getPinnedItems(client, 100);
    expect(result.body).toHaveLength(1);
    expect(result.body[0]!.id).toBe(99);
  });
});

describe('pinItem', () => {
  it('POSTs /project/<id>/pinned-items with the body (link is the wire field, NOT url)', async () => {
    const client = fakeClient(samplePin);
    await pinItem(client, 100, { link: 'https://example.com/spec', title: 'Spec doc' });
    expect(client.calls[0]!['method']).toBe('POST');
    expect(client.calls[0]!['path']).toBe('/project/100/pinned-items');
    expect(client.calls[0]!['body']).toEqual({
      link: 'https://example.com/spec',
      title: 'Spec doc',
    });
  });

  it('does not include signal / requestId when absent', async () => {
    const client = fakeClient(samplePin);
    await pinItem(client, 100, { link: 'https://x' });
    expect(client.calls[0]).not.toHaveProperty('signal');
    expect(client.calls[0]).not.toHaveProperty('requestId');
  });

  it('threads opts.signal', async () => {
    const client = fakeClient(samplePin);
    const ac = new AbortController();
    await pinItem(client, 100, { link: 'https://x' }, { signal: ac.signal });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
  });

  it('threads opts.requestId', async () => {
    const client = fakeClient(samplePin);
    await pinItem(client, 100, { link: 'https://x' }, { requestId: 'req-add' });
    expect(client.calls[0]!['requestId']).toBe('req-add');
  });
});

describe('deletePinnedItem', () => {
  it('DELETEs /pinned-item/<id>', async () => {
    const client = fakeClient({ result: 'success' });
    await deletePinnedItem(client, 99);
    expect(client.calls[0]!['method']).toBe('DELETE');
    expect(client.calls[0]!['path']).toBe('/pinned-item/99');
  });

  it('does not include signal / requestId when absent', async () => {
    const client = fakeClient({ result: 'success' });
    await deletePinnedItem(client, 99);
    expect(client.calls[0]).not.toHaveProperty('signal');
    expect(client.calls[0]).not.toHaveProperty('requestId');
  });

  it('threads opts.signal', async () => {
    const client = fakeClient({ result: 'success' });
    const ac = new AbortController();
    await deletePinnedItem(client, 99, { signal: ac.signal });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
  });

  it('threads opts.requestId', async () => {
    const client = fakeClient({ result: 'success' });
    await deletePinnedItem(client, 99, { requestId: 'req-del' });
    expect(client.calls[0]!['requestId']).toBe('req-del');
  });
});
