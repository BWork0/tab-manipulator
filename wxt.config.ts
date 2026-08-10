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
    description:
      'Rotate selected tabs automatically and refresh them on a schedule, with all data kept on your device.',
    permissions: ['tabs', 'storage', 'alarms'],
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'tab-manipulator@bwork0.github.io',
              strict_min_version: '140.0',
              data_collection_permissions: {
                required: ['none'],
              },
            },
          },
        }
      : {
          minimum_chrome_version: '120',
        }),
  }),
});
