import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Scoped, for the same reason `include` below is: without it vitest walks the whole tree and
    // benchmarks every copy of this repository under `.claude/worktrees/**` alongside the real one.
    // Three runs of everything, two of which fail to load — so `pnpm bench` exited 1 while the
    // numbers it did print were an average over stale checkouts.
    benchmark: { include: ['src/**/*.bench.ts'] },
    coverage: {
      exclude: ['src/**/*.test.ts', 'src/**/*.test-d.ts', 'src/**/*.bench.ts', 'src/cli.ts'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      // A ratchet, not a fixed bar: autoUpdate rewrites these numbers up to match
      // reality whenever coverage improves.
      thresholds: {
        autoUpdate: true,
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
    include: ['src/**/*.test.ts'],
  },
})
