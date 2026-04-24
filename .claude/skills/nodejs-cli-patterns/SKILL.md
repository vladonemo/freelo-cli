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

Startup time matters for a CLI. For infrequent heavy commands, register a stub that dynamic-imports the real module on demand:

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

Highest precedence wins:

1. CLI flag (`--profile personal`)
2. Env var (`FREELO_PROFILE=personal`)
3. Project config (`cosmiconfig` — `freelo.config.ts`, `.freelorc`)
4. User config (`conf` — `~/.config/freelo-cli/config.json`)
5. Built-in defaults

Resolution happens once at startup into a frozen `AppConfig` object. Commands read from the object, never from env directly.

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

Human mode: `pino-pretty` transport; JSON mode in CI and when `--json` is set.

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
