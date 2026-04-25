import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './msw/handlers.js';

// Shared MSW server. Tests register per-suite handlers via server.use(...)
// or use the exported factory helpers in test/msw/handlers.ts.
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
