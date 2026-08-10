import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  zip: {
    exclude: ['**/*.map'],
    excludeSources: [
      'AGENTS.md',
      'coverage',
      'docs',
      'prd-background',
      'tests',
      'scripts/t063-*',
      'scripts/t064-*',
      'scripts/verify-formatting-safeguards.mjs',
      'vitest.config.ts',
    ],
  },
  manifest: ({ browser }) => ({
    name: 'Tab Manipulator',
    description: 'Automatically rotate and refresh selected browser tabs on a schedule.',
    permissions: ['tabs', 'storage', 'alarms'],
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              data_collection_permissions: {
                required: ['none'],
              },
            },
          },
        }
      : {}),
  }),
});
