import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test-d.ts',
        'src/**/*.bench.ts',
        'src/testSupport/**',
        'scripts/**',
        'src/cli.ts',
      ],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      // A ratchet, not a fixed bar: autoUpdate rewrites these numbers up to match
      // reality whenever coverage improves; starts at 0 since there's no code yet.
      thresholds: {
        autoUpdate: true,
        branches: 0,
        functions: 0,
        lines: 0,
        statements: 0,
      },
    },
    include: ['src/**/*.test.ts'],
  },
})
