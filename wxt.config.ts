import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'Tab Manipulator',
    description: 'Automatically rotate and refresh selected browser tabs on a schedule.',
    permissions: ['tabs', 'storage', 'alarms'],
  },
});
