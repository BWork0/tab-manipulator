import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

function exposeWxtEnvironmentToVitest(): Plugin {
  const environmentPrefix = 'import.meta.env.';

  return {
    name: 'wxt:vitest-environment',
    enforce: 'post',
    configResolved(config) {
      // Vitest reads import.meta.env from config.env before Vite applies WXT's define entries.
      for (const [key, value] of Object.entries(config.define ?? {})) {
        if (key.startsWith(environmentPrefix) && typeof value === 'string') {
          config.env[key.slice(environmentPrefix.length)] = JSON.parse(value);
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [WxtVitest(), exposeWxtEnvironmentToVitest()],
  test: {
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/core/**/*.ts', 'src/storage/**/*.ts'],
    },
  },
});
