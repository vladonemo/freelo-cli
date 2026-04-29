/**
 * Unit tests for `src/api/notifications.ts` (R28, spec 0040).
 *
 * Mix of pure-function tests for path helpers and MSW-driven tests for the
 * three wire calls. Covers:
 *   - Path helpers
 *   - Query-string assembly for `getAllNotifications` (every filter shape)
 *   - Schema-validation pass-through (passthrough on Notification)
 *   - 4xx propagation as `FreeloApiError`
 *   - Optional spread arms (`signal`, `requestId`) for branch coverage
 */

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { createHttpClient } from '../../src/api/client.js';
import {
  ALL_NOTIFICATIONS_PATH,
  markNotificationReadPath,
  markNotificationUnreadPath,
  getAllNotifications,
  markNotificationAsRead,
  markNotificationAsUnread,
} from '../../src/api/notifications.js';
import { server, notificationsHandlers, API_BASE } from '../msw/handlers.js';
import { FreeloApiError } from '../../src/errors/freelo-api-error.js';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient() {
  return createHttpClient({
    email: 'agent@example.com',
    apiKey: 'sk-test',
    apiBaseUrl: API_BASE,
    userAgent: 'freelo-cli-test/0.0.0',
  });
}

const NOTIF = {
  id: 1001,
  type: 'task_assigned',
  date_action: '2026-04-25T10:00:00Z',
  author: { id: 7, fullname: 'Alice' },
  who: { id: 8, fullname: 'Bob' },
  is_unread: true,
  is_new: true,
  task: { id: 5, name: 'Ship R28' },
  tasklist: { id: 3, name: 'Backlog' },
  project: { id: 11, name: 'Apollo' },
  comment: null,
  document: null,
  file: null,
  more_comments: false,
  more_users: [],
};

const PAGE_FIXTURE = (notifs: unknown[] = [NOTIF]) => ({
  total: notifs.length,
  count: notifs.length,
  page: 0,
  per_page: 25,
  data: { notifications: notifs },
});

describe('notifications path helpers', () => {
  it('ALL_NOTIFICATIONS_PATH is /all-notifications', () => {
    expect(ALL_NOTIFICATIONS_PATH).toBe('/all-notifications');
  });

  it('markNotificationReadPath formats /notification/<id>/mark-as-read', () => {
    expect(markNotificationReadPath(42)).toBe('/notification/42/mark-as-read');
  });

  it('markNotificationUnreadPath formats /notification/<id>/mark-as-unread', () => {
    expect(markNotificationUnreadPath(42)).toBe('/notification/42/mark-as-unread');
  });
});

describe('getAllNotifications — query-string assembly', () => {
  it('default filters: only `p` is present', async () => {
    let observed: string | null = null;
    server.use(
      notificationsHandlers.spy(PAGE_FIXTURE(), (req) => {
        observed = new URL(req.url).search;
      }),
    );
    await getAllNotifications(makeClient(), { page: 0, filters: {} });
    expect(observed).toBe('?p=0');
  });

  it('--unread → `only_unread=true`', async () => {
    let observed: string | null = null;
    server.use(
      notificationsHandlers.spy(PAGE_FIXTURE(), (req) => {
        observed = new URL(req.url).search;
      }),
    );
    await getAllNotifications(makeClient(), {
      page: 0,
      filters: { onlyUnread: true },
    });
    expect(observed).toContain('only_unread=true');
  });

  it('multiple --project values become repeated `projects_ids[]`', async () => {
    let observed: string | null = null;
    server.use(
      notificationsHandlers.spy(PAGE_FIXTURE(), (req) => {
        observed = new URL(req.url).search;
      }),
    );
    await getAllNotifications(makeClient(), {
      page: 0,
      filters: { projects: [11, 22] },
    });
    expect(observed).toContain('projects_ids%5B%5D=11');
    expect(observed).toContain('projects_ids%5B%5D=22');
  });

  it('--type values become repeated `notification_types[]`', async () => {
    let observed: string | null = null;
    server.use(
      notificationsHandlers.spy(PAGE_FIXTURE(), (req) => {
        observed = new URL(req.url).search;
      }),
    );
    await getAllNotifications(makeClient(), {
      page: 0,
      filters: { types: ['task_assigned', 'comment_created'] },
    });
    expect(observed).toContain('notification_types%5B%5D=task_assigned');
    expect(observed).toContain('notification_types%5B%5D=comment_created');
  });

  it('combination: all filters + page', async () => {
    let observed: string | null = null;
    server.use(
      notificationsHandlers.spy(PAGE_FIXTURE(), (req) => {
        observed = new URL(req.url).search;
      }),
    );
    await getAllNotifications(makeClient(), {
      page: 2,
      filters: {
        onlyUnread: true,
        projects: [11],
        types: ['task_assigned'],
      },
    });
    expect(observed).toContain('p=2');
    expect(observed).toContain('only_unread=true');
    expect(observed).toContain('projects_ids%5B%5D=11');
    expect(observed).toContain('notification_types%5B%5D=task_assigned');
  });

  it('honours signal and requestId (optional spread coverage)', async () => {
    server.use(notificationsHandlers.paged({ 0: PAGE_FIXTURE() }));
    const controller = new AbortController();
    const out = await getAllNotifications(makeClient(), {
      page: 0,
      filters: {},
      signal: controller.signal,
      requestId: '11111111-2222-4333-8444-555555555555',
    });
    expect(out.page.data).toHaveLength(1);
    expect(out.page.data[0]?.id).toBe(1001);
  });

  it('parses notifications via NotificationSchema (passthrough)', async () => {
    const customNotif = {
      id: 2002,
      type: 'comment_created',
      future_field: 'unknown',
    };
    server.use(notificationsHandlers.paged({ 0: PAGE_FIXTURE([customNotif]) }));
    const out = await getAllNotifications(makeClient(), { page: 0, filters: {} });
    expect(out.page.data).toHaveLength(1);
    expect(out.page.data[0]?.id).toBe(2002);
  });

  it('401 → FreeloApiError', async () => {
    server.use(notificationsHandlers.unauthorized());
    await expect(
      getAllNotifications(makeClient(), { page: 0, filters: {} }),
    ).rejects.toBeInstanceOf(FreeloApiError);
  });

  it('500 → FreeloApiError', async () => {
    server.use(notificationsHandlers.serverError(500));
    await expect(
      getAllNotifications(makeClient(), { page: 0, filters: {} }),
    ).rejects.toBeInstanceOf(FreeloApiError);
  });
});

describe('markNotificationAsRead', () => {
  it('POSTs to /notification/<id>/mark-as-read with empty body', async () => {
    let observedBody: unknown = null;
    server.use(
      notificationsHandlers.markReadOkSpy(async (req) => {
        observedBody = await req
          .clone()
          .json()
          .catch(() => null);
      }),
    );
    const out = await markNotificationAsRead(makeClient(), 42);
    expect(observedBody).toEqual({});
    expect(out.raw.data).toEqual(expect.objectContaining({ result: 'success' }));
  });

  it('honours signal (optional spread coverage)', async () => {
    server.use(notificationsHandlers.markReadOk());
    const controller = new AbortController();
    const out = await markNotificationAsRead(makeClient(), 42, {
      signal: controller.signal,
    });
    expect(out.raw.data).toEqual(expect.objectContaining({ result: 'success' }));
  });

  it('honours requestId (optional spread coverage)', async () => {
    server.use(notificationsHandlers.markReadOk());
    const out = await markNotificationAsRead(makeClient(), 42, {
      requestId: '11111111-2222-4333-8444-555555555555',
    });
    expect(out.raw.data).toEqual(expect.objectContaining({ result: 'success' }));
  });

  it('404 → FreeloApiError', async () => {
    server.use(notificationsHandlers.markReadNotFound(42));
    await expect(markNotificationAsRead(makeClient(), 42)).rejects.toBeInstanceOf(FreeloApiError);
  });
});

describe('markNotificationAsUnread', () => {
  it('POSTs to /notification/<id>/mark-as-unread with empty body', async () => {
    let observedBody: unknown = null;
    server.use(
      notificationsHandlers.markUnreadOkSpy(async (req) => {
        observedBody = await req
          .clone()
          .json()
          .catch(() => null);
      }),
    );
    const out = await markNotificationAsUnread(makeClient(), 42);
    expect(observedBody).toEqual({});
    expect(out.raw.data).toEqual(expect.objectContaining({ result: 'success' }));
  });

  it('honours signal (optional spread coverage)', async () => {
    server.use(notificationsHandlers.markUnreadOk());
    const controller = new AbortController();
    const out = await markNotificationAsUnread(makeClient(), 42, {
      signal: controller.signal,
    });
    expect(out.raw.data).toEqual(expect.objectContaining({ result: 'success' }));
  });

  it('honours requestId (optional spread coverage)', async () => {
    server.use(notificationsHandlers.markUnreadOk());
    const out = await markNotificationAsUnread(makeClient(), 42, {
      requestId: '11111111-2222-4333-8444-555555555555',
    });
    expect(out.raw.data).toEqual(expect.objectContaining({ result: 'success' }));
  });

  it('404 → FreeloApiError', async () => {
    server.use(notificationsHandlers.markUnreadNotFound(42));
    await expect(markNotificationAsUnread(makeClient(), 42)).rejects.toBeInstanceOf(FreeloApiError);
  });
});
