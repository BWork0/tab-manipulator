import {
  ELIGIBLE_TAB_PROTOCOLS,
  TAB_INELIGIBILITY_REASONS,
  evaluateTabEligibility,
  type TabEligibility,
} from '@/core/tab-eligibility';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('tab URL eligibility', () => {
  it.each([
    'https://example.com/',
    'https://example.com/path?query=value#section',
    'http://example.test/',
    'http://localhost:5173/',
    'http://app.localhost:3000/dashboard',
    'https://127.0.0.1:8443/',
    'http://[::1]:4173/',
  ])('accepts an ordinary or local-development web URL: %s', (url) => {
    expect(evaluateTabEligibility(url)).toEqual({ eligible: true });
  });

  it.each([
    'chrome-extension://abcdefghijklmnop/options.html',
    'moz-extension://12345678-1234-1234-1234-123456789abc/options.html',
  ])('rejects an extension page with a specific reason: %s', (url) => {
    expect(evaluateTabEligibility(url)).toEqual({
      eligible: false,
      reason: 'extension-url',
    });
  });

  it.each([
    'chrome://settings/',
    'chrome://extensions/',
    'edge://settings/',
    'about:preferences',
    'about:addons',
    'brave://settings/',
    'opera://settings/',
    'vivaldi://settings/',
    'view-source:https://example.com/',
  ])('rejects a browser-internal page with a specific reason: %s', (url) => {
    expect(evaluateTabEligibility(url)).toEqual({
      eligible: false,
      reason: 'browser-internal-url',
    });
  });

  it.each([
    'file:///C:/tmp/dashboard.html',
    'ftp://example.com/archive',
    'data:text/plain,hello',
    'blob:https://example.com/00000000-0000-0000-0000-000000000000',
    'javascript:void(0)',
  ])('rejects a non-web scheme consistently: %s', (url) => {
    expect(evaluateTabEligibility(url)).toEqual({
      eligible: false,
      reason: 'unsupported-scheme',
    });
  });

  it.each([undefined, null, '', '   '])('handles a missing URL safely: %s', (url) => {
    expect(evaluateTabEligibility(url)).toEqual({
      eligible: false,
      reason: 'missing-url',
    });
  });

  it.each(['not a URL', 'https://', 'http://exa mple.com', 42, {}])(
    'handles malformed input safely: %s',
    (url) => {
      expect(evaluateTabEligibility(url)).toEqual({
        eligible: false,
        reason: 'malformed-url',
      });
    },
  );

  it('exports the cross-browser protocol policy and typed reasons', () => {
    const result = evaluateTabEligibility('chrome://settings/');

    expect(ELIGIBLE_TAB_PROTOCOLS).toEqual(['http:', 'https:']);
    expect(TAB_INELIGIBILITY_REASONS).toEqual([
      'missing-url',
      'malformed-url',
      'browser-internal-url',
      'extension-url',
      'unsupported-scheme',
    ]);
    expectTypeOf(result).toMatchTypeOf<TabEligibility>();
  });
});
