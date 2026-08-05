export type RuleListName = 'allowlist' | 'blocklist';

export type RuleValidationErrorCode =
  | 'invalid-domain'
  | 'invalid-url-pattern'
  | 'unsupported-scheme'
  | 'invalid-host-pattern'
  | 'invalid-port';

export interface RuleValidationError {
  line: number;
  value: string;
  code: RuleValidationErrorCode;
}

export interface RuleConfigurationError extends RuleValidationError {
  list: RuleListName;
}

export interface PlainDomainRule {
  kind: 'domain';
  normalized: string;
  domain: string;
}

export interface WildcardUrlRule {
  kind: 'url-pattern';
  normalized: string;
  scheme: 'http' | 'https' | '*';
  hostnamePattern: string;
  portPattern?: string;
  remainderPattern: string;
}

export type ParsedRule = PlainDomainRule | WildcardUrlRule;

export type RuleListParseResult =
  | {
      valid: true;
      rules: readonly ParsedRule[];
      normalized: readonly string[];
    }
  | {
      valid: false;
      errors: readonly RuleValidationError[];
    };

export interface RuleConfiguration {
  allowlist: readonly ParsedRule[];
  blocklist: readonly ParsedRule[];
  normalizedAllowlist: readonly string[];
  normalizedBlocklist: readonly string[];
}

export type RuleConfigurationParseResult =
  | { valid: true; configuration: RuleConfiguration }
  | { valid: false; errors: readonly RuleConfigurationError[] };

export type RuleDecision =
  | { allowed: true; reason: 'empty-allowlist' }
  | { allowed: true; reason: 'allow-match'; matchedRule: string }
  | { allowed: false; reason: 'block-match'; matchedRule: string }
  | { allowed: false; reason: 'no-allow-match' }
  | { allowed: false; reason: 'invalid-url' };

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WILDCARD_HOST_LABEL = /^[a-z0-9*](?:[a-z0-9*-]{0,61}[a-z0-9*])?$/;
const URL_PATTERN = /^([^:]+):\/\/([^/?#]+)([/?#].*)?$/;

function isValidDomain(domain: string): boolean {
  return (
    domain.length <= 253 &&
    domain.split('.').every((label) => label.length > 0 && DOMAIN_LABEL.test(label))
  );
}

function isValidHostnamePattern(hostname: string): boolean {
  return (
    hostname.length <= 253 &&
    hostname.split('.').every((label) => label.length > 0 && WILDCARD_HOST_LABEL.test(label))
  );
}

function parseDomainRule(value: string): PlainDomainRule | RuleValidationErrorCode {
  if (value.includes('*') || value.includes('/') || value.includes(':')) {
    return 'invalid-domain';
  }

  const domain = value.toLowerCase().replace(/\.$/, '');

  if (!isValidDomain(domain)) {
    return 'invalid-domain';
  }

  return { kind: 'domain', normalized: domain, domain };
}

function splitAuthority(
  authority: string,
): { hostname: string; portPattern?: string } | RuleValidationErrorCode {
  if (authority.includes('@') || authority.startsWith('[') || authority.includes(']')) {
    return 'invalid-host-pattern';
  }

  const colonIndex = authority.lastIndexOf(':');

  if (colonIndex < 0) {
    return { hostname: authority };
  }

  if (authority.indexOf(':') !== colonIndex) {
    return 'invalid-host-pattern';
  }

  const hostname = authority.slice(0, colonIndex);
  const portPattern = authority.slice(colonIndex + 1);

  if (portPattern === '*') {
    return { hostname, portPattern };
  }

  if (!/^\d+$/.test(portPattern)) {
    return 'invalid-port';
  }

  const port = Number(portPattern);

  if (port < 1 || port > 65_535) {
    return 'invalid-port';
  }

  return { hostname, portPattern: String(port) };
}

function parseUrlPattern(value: string): WildcardUrlRule | RuleValidationErrorCode {
  if (/\s/.test(value)) {
    return 'invalid-url-pattern';
  }

  const match = URL_PATTERN.exec(value);

  if (!match) {
    return 'invalid-url-pattern';
  }

  const [, rawScheme, rawAuthority, rawRemainder] = match;

  if (rawScheme === undefined || rawAuthority === undefined) {
    return 'invalid-url-pattern';
  }

  const scheme = rawScheme.toLowerCase();

  if (scheme !== 'http' && scheme !== 'https' && scheme !== '*') {
    return 'unsupported-scheme';
  }

  const authority = splitAuthority(rawAuthority);

  if (typeof authority === 'string') {
    return authority;
  }

  const hostnamePattern = authority.hostname.toLowerCase().replace(/\.$/, '');

  if (!isValidHostnamePattern(hostnamePattern)) {
    return 'invalid-host-pattern';
  }

  let portPattern = authority.portPattern;

  if (
    (scheme === 'http' && portPattern === '80') ||
    (scheme === 'https' && portPattern === '443')
  ) {
    portPattern = undefined;
  }

  let remainderPattern = rawRemainder ?? '/';

  if (remainderPattern.startsWith('?') || remainderPattern.startsWith('#')) {
    remainderPattern = `/${remainderPattern}`;
  }

  const port = portPattern === undefined ? '' : `:${portPattern}`;
  const normalized = `${scheme}://${hostnamePattern}${port}${remainderPattern}`;

  if (!normalized.includes('*')) {
    return 'invalid-url-pattern';
  }

  return {
    kind: 'url-pattern',
    normalized,
    scheme,
    hostnamePattern,
    ...(portPattern === undefined ? {} : { portPattern }),
    remainderPattern,
  };
}

function parseRule(value: string): ParsedRule | RuleValidationErrorCode {
  return value.includes('://') ? parseUrlPattern(value) : parseDomainRule(value);
}

function toLines(input: string | readonly string[]): readonly string[] {
  return typeof input === 'string' ? input.split(/\r?\n/) : input;
}

/**
 * Parses a complete rule list atomically. Invalid input returns errors only, so callers cannot
 * accidentally save the valid subset of a list containing malformed lines.
 */
export function parseRuleList(input: string | readonly string[]): RuleListParseResult {
  const parsedRules: ParsedRule[] = [];
  const errors: RuleValidationError[] = [];
  const seen = new Set<string>();

  for (const [index, inputLine] of toLines(input).entries()) {
    const value = inputLine.trim();

    if (value === '') {
      continue;
    }

    const parsed = parseRule(value);

    if (typeof parsed === 'string') {
      errors.push({ line: index + 1, value, code: parsed });
      continue;
    }

    if (!seen.has(parsed.normalized)) {
      seen.add(parsed.normalized);
      parsedRules.push(parsed);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    rules: parsedRules,
    normalized: parsedRules.map((rule) => rule.normalized),
  };
}

/** Parses allowlist and blocklist input as one atomic settings value. */
export function parseRuleConfiguration(
  allowlist: string | readonly string[],
  blocklist: string | readonly string[],
): RuleConfigurationParseResult {
  const parsedAllowlist = parseRuleList(allowlist);
  const parsedBlocklist = parseRuleList(blocklist);
  const errors: RuleConfigurationError[] = [];

  if (!parsedAllowlist.valid) {
    errors.push(
      ...parsedAllowlist.errors.map((error) => ({ ...error, list: 'allowlist' as const })),
    );
  }

  if (!parsedBlocklist.valid) {
    errors.push(
      ...parsedBlocklist.errors.map((error) => ({ ...error, list: 'blocklist' as const })),
    );
  }

  if (errors.length > 0 || !parsedAllowlist.valid || !parsedBlocklist.valid) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    configuration: {
      allowlist: parsedAllowlist.rules,
      blocklist: parsedBlocklist.rules,
      normalizedAllowlist: parsedAllowlist.normalized,
      normalizedBlocklist: parsedBlocklist.normalized,
    },
  };
}

function matchesGlob(pattern: string, value: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let wildcardIndex = -1;
  let wildcardValueIndex = -1;

  while (valueIndex < value.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === value[valueIndex]) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === '*') {
      wildcardIndex = patternIndex;
      wildcardValueIndex = valueIndex;
      patternIndex += 1;
    } else if (wildcardIndex >= 0) {
      patternIndex = wildcardIndex + 1;
      wildcardValueIndex += 1;
      valueIndex = wildcardValueIndex;
    } else {
      return false;
    }
  }

  while (patternIndex < pattern.length && pattern[patternIndex] === '*') {
    patternIndex += 1;
  }

  return patternIndex === pattern.length;
}

function matchesParsedRule(url: URL, rule: ParsedRule): boolean {
  if (rule.kind === 'domain') {
    return url.hostname === rule.domain || url.hostname.endsWith(`.${rule.domain}`);
  }

  const scheme = url.protocol.slice(0, -1).toLowerCase();

  if (rule.scheme !== '*' && rule.scheme !== scheme) {
    return false;
  }

  if (!matchesGlob(rule.hostnamePattern, url.hostname.toLowerCase())) {
    return false;
  }

  if (rule.portPattern !== '*' && (rule.portPattern ?? '') !== url.port) {
    return false;
  }

  return matchesGlob(rule.remainderPattern, `${url.pathname}${url.search}${url.hash}`);
}

function findMatch(url: URL, rules: readonly ParsedRule[]): ParsedRule | undefined {
  return rules.find((rule) => matchesParsedRule(url, rule));
}

/** Applies blocklist precedence and empty-allowlist behavior to an ordinary HTTP(S) URL. */
export function evaluateUrlRules(url: unknown, configuration: RuleConfiguration): RuleDecision {
  if (typeof url !== 'string') {
    return { allowed: false, reason: 'invalid-url' };
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    return { allowed: false, reason: 'invalid-url' };
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { allowed: false, reason: 'invalid-url' };
  }

  const blockMatch = findMatch(parsedUrl, configuration.blocklist);

  if (blockMatch) {
    return { allowed: false, reason: 'block-match', matchedRule: blockMatch.normalized };
  }

  if (configuration.allowlist.length === 0) {
    return { allowed: true, reason: 'empty-allowlist' };
  }

  const allowMatch = findMatch(parsedUrl, configuration.allowlist);

  if (allowMatch) {
    return { allowed: true, reason: 'allow-match', matchedRule: allowMatch.normalized };
  }

  return { allowed: false, reason: 'no-allow-match' };
}
