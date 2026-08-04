import coreBoundary from '@/core/README.md?raw';
import { browser } from 'wxt/browser';
import { describe, expect, it } from 'vitest';
import { wxtEnvironment } from './fixtures/wxt-environment';

describe.sequential('WXT test environment', () => {
  it('resolves source aliases and built-in environment values', () => {
    expect(coreBoundary).toContain('# Core');
    expect(wxtEnvironment).toEqual({
      browser: 'chrome',
      manifestVersion: 3,
      chrome: true,
      firefox: false,
    });
  });

  it('provides the fake browser through wxt/browser', async () => {
    await browser.storage.local.set({ smokeTestValue: 'stored' });

    await expect(browser.storage.local.get('smokeTestValue')).resolves.toEqual({
      smokeTestValue: 'stored',
    });
  });

  it('resets fake browser state between tests', async () => {
    await expect(browser.storage.local.get('smokeTestValue')).resolves.toEqual({});
  });
});
