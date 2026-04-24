import { afterAll, afterEach, beforeAll } from 'vitest';
import { setupServer } from 'msw/node';
import { handlers } from './msw/handlers.js';

// Shared MSW server. Empty handler list in the initial scaffold —
// future API tests register handlers here or add per-test overrides via
// `server.use(...)`.
export const server = setupServer(...handlers);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
