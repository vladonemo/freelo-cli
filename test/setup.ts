import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './msw/handlers.js';

// Skip the 200ms Windows libuv exit-delay (`exitDeferred` in
// `src/errors/handle.ts`) in tests. Production keeps it for the real
// libuv-handle race; tests stub `process.exit` and don't need it.
process.env['FREELO_EXIT_DELAY_MS'] = '0';

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
