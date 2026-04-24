---
name: nodejs-cli-patterns
description: Implementation patterns for Node.js CLIs — Commander wiring, ESM quirks, shebang + bundle, signal handling, TTY detection, config resolution. Load when wiring new commands or debugging runtime behavior.
---

# Node.js CLI — implementation patterns

Opinionated defaults that make the Freelo CLI feel native on macOS, Linux, and Windows.

## Entry point

`src/bin/freelo.ts`:

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { registerAuth } from '../commands/auth.js';
// ...

async function main() {
  const program = new Command()
    .name('freelo')
    .description('Command-line interface for Freelo.io')
    .version(VERSION);

  registerAuth(program);
  // ...

  await program.parseAsync(process.argv);
}

main().catch(handleTopLevelError);
```

The shebang must survive bundling — `tsup` preserves it when the source starts with `#!/usr/bin/env node`.

## Bundling with tsup

```ts
// tsup.config.ts
export default defineConfig({
  entry: { freelo: 'src/bin/freelo.ts' },
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
  minify: false,
  banner: { js: '#!/usr/bin/env node' },
});
```

Output: single file `dist/freelo.js` with a shebang. `package.json` points `"bin": { "freelo": "dist/freelo.js" }` and `"files": ["dist"]`.

Set the file executable in CI before publish: `chmod +x dist/freelo.js` (no-op on Windows; npm preserves the shebang either way).

## ESM gotchas

- Always include `.js` in relative imports. `tsup` and `tsc` expect it.
- No `__dirname` / `__filename`. Use `import.meta.url`:
  ```ts
  import { fileURLToPath } from 'node:url';
  const here = fileURLToPath(new URL('.', import.meta.url));
  ```
- Dynamic imports work but defeat tree-shaking unless the path is static. Keep them for genuine lazy-loading of heavy command modules.

## Lazy command loading

Startup time matters for a CLI — especially the agent cold path. For infrequent heavy commands, register a stub that dynamic-imports the real module on demand:

```ts
program
  .command('report')
  .description('Generate a time report')
  .action(async (...args) => {
    const { run } = await import('./report.js');
    return run(...args);
  });
```

Don't do this for the common-path commands — the extra import is measurable.

## Lazy human-UX dependencies (mandatory)

`@inquirer/prompts`, `ora`, `boxen`, `cli-table3`, `chalk`, `pino-pretty`, `update-notifier` **must not** appear in any top-level static `import`. They only exist on the human path.

```ts
// src/ui/table.ts
export async function renderTable(rows: Row[], opts: TableOpts) {
  const { default: CliTable3 } = await import('cli-table3');
  const { default: chalk } = await import('chalk');
  // ...
}
```

Callers check `isInteractive` before reaching for a renderer that lazy-imports these. ESLint rule `no-restricted-imports` enforces the static-import ban.

## TTY detection — one place

```ts
// src/lib/env.ts
export const isInteractive = process.stdout.isTTY && !process.env.CI;
export const wantsColor =
  isInteractive &&
  !process.env.NO_COLOR &&
  process.env.FORCE_COLOR !== '0';

export type OutputMode = 'auto' | 'human' | 'json' | 'ndjson';
export function resolveOutputMode(flag: OutputMode, envOverride?: string): Exclude<OutputMode, 'auto'> {
  if (flag === 'auto') return isInteractive ? 'human' : 'json';
  return flag;
}
```

Every place that needs TTY state or output mode imports from here. Don't sprinkle `process.stdout.isTTY` across the codebase.

## Signal handling

```ts
process.on('SIGINT', () => {
  // stop any running spinner, flush pino, exit 130
  spinner?.stop();
  process.exit(130);
});
```

Don't `process.exit()` mid-API-call without cleanup — finalize the spinner and close the pino transport.

## TTY detection — one place

```ts
// src/lib/env.ts
export const isInteractive = process.stdout.isTTY && !process.env.CI;
export const wantsColor = isInteractive && !process.env.NO_COLOR;
```

Every place that needs to know TTY state imports from here. Don't sprinkle `process.stdout.isTTY` across the codebase.

## Config resolution order

### Non-secret settings (highest precedence wins)

1. CLI flag (`--profile personal`)
2. Env var (`FREELO_PROFILE=personal`, `FREELO_OUTPUT=json`, ...)
3. Project config (`cosmiconfig` — `freelo.config.ts`, `.freelorc`)
4. User config (`conf` — `~/.config/freelo-cli/config.json`)
5. Built-in defaults

### Credentials (env-first — never forces keychain on headless agents)

1. CLI flag `--api-key-stdin` (read once at startup)
2. Env vars `FREELO_API_KEY` + `FREELO_EMAIL` (or `FREELO_TOKEN`) — **skips keychain entirely** when set
3. OS keychain via `keytar` — skipped if `FREELO_NO_KEYCHAIN=1` or if step 2 resolved
4. `conf` file (0600 perms)

Resolution happens once at startup into a frozen `AppConfig` object. Commands read from the object, never from env directly. `freelo config resolve --output json` emits the merged config (secrets redacted, each setting annotated with its source) — useful for agents debugging drift.

## HTTP client defaults

```ts
import { Agent, fetch } from 'undici';

const agent = new Agent({
  connect: { timeout: 10_000 },
  headersTimeout: 30_000,
  bodyTimeout: 60_000,
});

// in request:
await fetch(url, { dispatcher: agent, signal, headers });
```

- Pass an `AbortSignal` from every call so SIGINT can abort in-flight requests.
- No redirects to non-allowed hosts (see `security-auditor`).
- Retry GETs on network errors and 5xx with exponential backoff, jittered, max 3 attempts.

## Logging

`pino` at the top of every request, never in tight loops:

```ts
logger.debug({ method, path, status, durationMs, requestId }, 'freelo api call');
```

**Default level is `silent`.** Agents get a clean stderr. `-v` → `info` (one line per API call), `-vv` / `FREELO_DEBUG=1` → `debug` (full request/response metadata + request IDs).

`pino-pretty` is lazy-loaded and attached only in TTY + `human` mode. Non-TTY paths emit raw JSON lines to stderr so agents can pipe them directly to a log collector.

## Windows

- Always use `path.join` / `path.resolve`. No hardcoded `/`.
- `keytar` works on Windows but requires the Credential Manager — fall back to encrypted `conf` if it throws on first use.
- Test matrix includes `windows-latest` — a test that relies on POSIX-only behavior is a bug in the test.

## Version reporting

`--version` comes from `package.json`:

```ts
import pkg from '../../package.json' with { type: 'json' };
program.version(pkg.version);
```

Import attributes (`with { type: 'json' }`) require Node 20+. The build embeds the JSON, so runtime doesn't need to read the file.
