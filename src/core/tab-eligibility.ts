export const ELIGIBLE_TAB_PROTOCOLS = ['http:', 'https:'] as const;

export type EligibleTabProtocol = (typeof ELIGIBLE_TAB_PROTOCOLS)[number];

export const TAB_INELIGIBILITY_REASONS = [
  'missing-url',
  'malformed-url',
  'browser-internal-url',
  'extension-url',
  'unsupported-scheme',
] as const;

export type TabIneligibilityReason = (typeof TAB_INELIGIBILITY_REASONS)[number];

export type TabEligibility =
  { eligible: true } | { eligible: false; reason: TabIneligibilityReason };

const BROWSER_INTERNAL_PROTOCOLS = new Set([
  'about:',
  'brave:',
  'chrome:',
  'chrome-error:',
  'chrome-search:',
  'chrome-untrusted:',
  'devtools:',
  'edge:',
  'edge-search:',
  'opera:',
  'resource:',
  'view-source:',
  'vivaldi:',
]);

const EXTENSION_PROTOCOLS = new Set(['chrome-extension:', 'moz-extension:']);
const ELIGIBLE_PROTOCOLS = new Set<string>(ELIGIBLE_TAB_PROTOCOLS);

const ELIGIBLE_RESULT = Object.freeze({ eligible: true }) satisfies TabEligibility;

/**
 * Applies the shared Chromium/Firefox policy for tabs that may be activated and reloaded.
 * Only ordinary HTTP(S) documents are accepted so the result never depends on browser APIs,
 * optional file access, or browser-specific privileged-page behavior.
 */
export function evaluateTabEligibility(url: unknown): TabEligibility {
  if (url == null || (typeof url === 'string' && url.trim() === '')) {
    return { eligible: false, reason: 'missing-url' };
  }

  if (typeof url !== 'string') {
    return { eligible: false, reason: 'malformed-url' };
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    return { eligible: false, reason: 'malformed-url' };
  }

  if (BROWSER_INTERNAL_PROTOCOLS.has(parsedUrl.protocol)) {
    return { eligible: false, reason: 'browser-internal-url' };
  }

  if (EXTENSION_PROTOCOLS.has(parsedUrl.protocol)) {
    return { eligible: false, reason: 'extension-url' };
  }

  if (!ELIGIBLE_PROTOCOLS.has(parsedUrl.protocol)) {
    return { eligible: false, reason: 'unsupported-scheme' };
  }

  return ELIGIBLE_RESULT;
}
