import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
        // Per-directory targets for high-value layers.
        // Vitest v2 treats any non-standard string key as a glob pattern.
        // lines/statements are set to the SDLC target (90%); branches/functions
        // reflect the current coverage floor for the interactive paths in login.ts
        // that require TTY prompts (validate callbacks) — raise when those are tested.
        'src/api/**': {
          lines: 90,
          functions: 80,
          branches: 80,
          statements: 90,
        },
        'src/commands/**': {
          lines: 90,
          functions: 90,
          branches: 85,
          statements: 90,
        },
      },
    },
  },
});
