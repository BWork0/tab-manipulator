import {
  evaluateUrlRules,
  parseRuleConfiguration,
  parseRuleList,
  type RuleConfiguration,
} from '@/core/rule-engine';
import { describe, expect, it } from 'vitest';

function validConfiguration(allowlist: string, blocklist = ''): RuleConfiguration {
  const result = parseRuleConfiguration(allowlist, blocklist);

  if (!result.valid) {
    throw new Error(`Expected valid rules: ${JSON.stringify(result.errors)}`);
  }

  return result.configuration;
}

describe('rule parsing', () => {
  it('trims, normalizes, and deduplicates domains and URL patterns', () => {
    const result = parseRuleList(`
      Example.COM
      example.com.
      HTTPS://*.Example.COM/*
      https://*.example.com/*
      https://example.com:443/Admin/*
    `);

    expect(result).toMatchObject({
      valid: true,
      normalized: ['example.com', 'https://*.example.com/*', 'https://example.com/Admin/*'],
    });
  });

  it('preserves case in the path, query, and fragment when deduplicating', () => {
    const result = parseRuleList([
      'HTTPS://EXAMPLE.COM/Reports/*?View=*#Top',
      'https://example.com/reports/*?View=*#Top',
    ]);

    expect(result).toMatchObject({
      valid: true,
      normalized: [
        'https://example.com/Reports/*?View=*#Top',
        'https://example.com/reports/*?View=*#Top',
      ],
    });
  });

  it.each([
    ['bad domain', 'invalid-domain'],
    ['example..com', 'invalid-domain'],
    ['-example.com', 'invalid-domain'],
    ['*.example.com', 'invalid-domain'],
    ['https://example.com/path', 'invalid-url-pattern'],
    ['ftp://example.com/*', 'unsupported-scheme'],
    ['https://user@example.com/*', 'invalid-host-pattern'],
    ['https://example..com/*', 'invalid-host-pattern'],
    ['https://example.com:0/*', 'invalid-port'],
    ['https://example.com:65536/*', 'invalid-port'],
    ['https://example.com:abc/*', 'invalid-port'],
    ['https://example.com/a path/*', 'invalid-url-pattern'],
  ])('rejects invalid rule %s with %s', (rule, code) => {
    expect(parseRuleList(rule)).toEqual({
      valid: false,
      errors: [{ line: 1, value: rule, code }],
    });
  });

  it('reports every offending line and does not expose a partial normalized value', () => {
    const result = parseRuleList(
      'example.com\nnot a domain\nhttps://valid.example/*\nftp://bad.example/*',
    );

    expect(result).toEqual({
      valid: false,
      errors: [
        { line: 2, value: 'not a domain', code: 'invalid-domain' },
        { line: 4, value: 'ftp://bad.example/*', code: 'unsupported-scheme' },
      ],
    });
    expect(result).not.toHaveProperty('rules');
    expect(result).not.toHaveProperty('normalized');
  });

  it('validates allowlist and blocklist as one atomic configuration', () => {
    const result = parseRuleConfiguration(
      'example.com\ninvalid domain',
      'blocked.example\nhttps://example.com:70000/*',
    );

    expect(result).toEqual({
      valid: false,
      errors: [
        {
          list: 'allowlist',
          line: 2,
          value: 'invalid domain',
          code: 'invalid-domain',
        },
        {
          list: 'blocklist',
          line: 2,
          value: 'https://example.com:70000/*',
          code: 'invalid-port',
        },
      ],
    });
    expect(result).not.toHaveProperty('configuration');
  });
});

describe('rule matching', () => {
  it.each([
    ['https://example.com/', true],
    ['https://www.example.com/path', true],
    ['http://deep.sub.example.com:8080/path', true],
    ['https://example.com.evil.test/', false],
    ['https://another-example.com/', false],
  ])('matches a plain domain and its subdomains: %s', (url, expected) => {
    const configuration = validConfiguration('example.com');

    expect(evaluateUrlRules(url, configuration).allowed).toBe(expected);
  });

  it.each([
    ['https://app.example.com/Reports/Today', true],
    ['HTTPS://APP.EXAMPLE.COM/Reports/Today', true],
    ['http://app.example.com/Reports/Today', false],
    ['https://app.example.com/reports/Today', false],
    ['https://example.com/Reports/Today', false],
  ])('uses insensitive scheme/host and a sensitive URL remainder: %s', (url, expected) => {
    const configuration = validConfiguration('https://*.Example.COM/Reports/*');

    expect(evaluateUrlRules(url, configuration).allowed).toBe(expected);
  });

  it.each([
    ['http://example.com/api', true],
    ['https://example.com/api', true],
    ['https://sub.example.com/api', true],
    ['https://sub.example.com/API', false],
  ])('supports wildcard schemes, hosts, and paths: %s', (url, expected) => {
    const configuration = validConfiguration('*://*example.com/api*');

    expect(evaluateUrlRules(url, configuration).allowed).toBe(expected);
  });

  it.each([
    ['https://example.com/dashboard', 'https://example.com/*', true],
    ['https://example.com:8443/dashboard', 'https://example.com/*', false],
    ['https://example.com:8443/dashboard', 'https://example.com:8443/*', true],
    ['https://example.com:9443/dashboard', 'https://example.com:8443/*', false],
    ['https://example.com:8443/dashboard', 'https://example.com:*/*', true],
    ['https://example.com/dashboard', 'https://example.com:*/*', true],
  ])('applies explicit, default, and wildcard port rules: %s against %s', (url, rule, expected) => {
    const configuration = validConfiguration(rule);

    expect(evaluateUrlRules(url, configuration).allowed).toBe(expected);
  });

  it('allows every valid URL when the allowlist is empty', () => {
    const configuration = validConfiguration('');

    expect(evaluateUrlRules('https://unlisted.example/path', configuration)).toEqual({
      allowed: true,
      reason: 'empty-allowlist',
    });
  });

  it('requires an allow match when the allowlist is non-empty', () => {
    const configuration = validConfiguration('allowed.example');

    expect(evaluateUrlRules('https://other.example/', configuration)).toEqual({
      allowed: false,
      reason: 'no-allow-match',
    });
  });

  it('gives the blocklist precedence over conflicting allow rules', () => {
    const configuration = validConfiguration('example.com', 'https://private.example.com/*');

    expect(evaluateUrlRules('https://private.example.com/report', configuration)).toEqual({
      allowed: false,
      reason: 'block-match',
      matchedRule: 'https://private.example.com/*',
    });
    expect(evaluateUrlRules('https://public.example.com/report', configuration)).toEqual({
      allowed: true,
      reason: 'allow-match',
      matchedRule: 'example.com',
    });
  });

  it.each([undefined, 'not a URL', 'file:///tmp/report.html'])(
    'rejects a malformed or non-web URL before matching: %s',
    (url) => {
      const configuration = validConfiguration('');

      expect(evaluateUrlRules(url, configuration)).toEqual({
        allowed: false,
        reason: 'invalid-url',
      });
    },
  );
});
