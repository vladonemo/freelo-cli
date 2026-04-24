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
      exclude: [
        'src/**/*.d.ts',
        'src/**/index.ts',
        // Abstract placeholder — first concrete subclass (added by the
        // errors spec) will bring it under coverage.
        'src/errors/**',
      ],
      thresholds: {
        // Pragmatic scaffold thresholds. The first user-visible feature
        // (auth/login) will raise these to the SDLC target of 80 % lines,
        // 90 % on src/api and src/commands.
        lines: 60,
        functions: 60,
        branches: 30,
        statements: 60,
      },
    },
  },
});
