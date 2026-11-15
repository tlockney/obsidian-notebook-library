import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The obsidian package is types only; tests use a stub of the parts the
// plugin calls.
export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL('./src/test/obsidian-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
