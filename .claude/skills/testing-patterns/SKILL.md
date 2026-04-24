---
name: testing-patterns
description: Testing patterns for the Freelo CLI — vitest structure, MSW setup, running Commander programs in-process, fixture hygiene. Load when writing or reviewing tests.
---

# Testing patterns

## Stack recap

- `vitest` — runner + coverage (`v8` provider)
- `msw` v2 — HTTP mocking at the `fetch` layer
- Fixtures under `test/fixtures/`

## Project layout

```
test/
├── setup.ts            vitest global setup — starts MSW server, clears conf between tests
├── msw/
│   ├── server.ts       setupServer()
│   ├── handlers.ts     default 200 handlers for every endpoint we touch
│   └── errors.ts       named factories: rateLimited(), unauthorized(), ...
├── fixtures/
│   ├── projects.list.json
│   └── tasks.single.json
├── commands/
│   └── tasks.list.test.ts   integration tests
├── api/
│   └── tasks.test.ts        unit tests for the API module
└── lib/
    └── format.test.ts
```

## vitest setup

`vitest.config.ts`:

```ts
export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 80,
        'src/api/**': { lines: 90 },
        'src/commands/**': { lines: 90 },
      },
    },
  },
});
```

`test/setup.ts`:

```ts
import { beforeAll, afterEach, afterAll } from 'vitest';
import { server } from './msw/server.js';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

`onUnhandledRequest: 'error'` is the rule — any unmocked request fails the test. This is what stops real network calls sneaking in.

## Running a Commander program in tests

```ts
import { makeProgram } from '#src/bin/freelo.js';

async function run(argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out.push(String(s)); return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err.push(String(s)); return true;
  });

  let code = 0;
  try {
    await makeProgram().parseAsync(['node', 'freelo', ...argv]);
  } catch (e) {
    code = handleError(e); // same path as bin/freelo.ts
  }
  stdout.mockRestore(); stderr.mockRestore();
  return { stdout: out.join(''), stderr: err.join(''), code };
}
```

Expose `makeProgram()` from `bin/freelo.ts` (factory, no side effects at import time) so tests can build a fresh program per case.

## Naming

```ts
describe('freelo tasks list', () => {
  it('renders a table of open tasks by default', async () => { ... });
  it('emits valid JSON with --output json', async () => { ... });
  it('exits 3 when no token is configured', async () => { ... });
  it('honors Retry-After on 429', async () => { ... });
});
```

Subject-first, indicative mood. Avoid "should" — it adds nothing.

## Fixtures

- One fixture = one scenario. `projects.list.empty.json`, `projects.list.three-items.json`.
- **Always scrubbed.** No real emails, IDs, or tokens. Use `user+<n>@example.com`, 4-digit IDs.
- Commit the exact shape the API returned — don't "clean it up" by removing fields. That's the point.

## Overriding MSW per test

```ts
server.use(
  http.get('https://api.freelo.io/v1/projects', () => HttpResponse.json({ ... }, { status: 403 })),
);
```

Handlers defined inside a test override the defaults from `handlers.ts`. Reset happens in `afterEach`.

## Snapshot tests

Allowed for table rendering, but:

- One snapshot per test. Don't batch.
- Review `-u` output carefully — a "fix" that changes output visibly is a contract change.
- Never snapshot timestamps or IDs that vary — scrub first.

## Flaky tests

Zero tolerance. If a test is timing-dependent:

- Replace real time with `vi.useFakeTimers()`.
- Replace random IDs/tokens with seeded generators.
- Order matters — never rely on test execution order; each test bootstraps its own state.

## What not to test

- Commander's arg parsing (library)
- Zod's validation logic (library)
- `chalk`'s color output (library)
- Our types — `tsc` does that

Test **our behavior**: what the user sees on TTY, what envelope agents get on non-TTY, what exit code they get, and what the stderr error envelope looks like on failure.
