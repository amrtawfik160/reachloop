import type { TwitterAuthCookies } from './client';

export type CookieParseResult =
  | { ok: true; cookies: TwitterAuthCookies }
  | { ok: false; missing: Array<'auth_token' | 'ct0'> };

const X_DOMAINS = ['x.com', 'twitter.com'];

function isXDomain(domain: unknown): boolean {
  if (typeof domain !== 'string') return true;
  const bare = domain.replace(/^\./, '');
  return X_DOMAINS.some((d) => bare === d || bare.endsWith(`.${d}`));
}

function fromJson(value: unknown): Map<string, string> {
  const found = new Map<string, string>();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue;
      const { name, value: cookieValue, domain } = item as Record<string, unknown>;
      if (typeof name === 'string' && typeof cookieValue === 'string' && isXDomain(domain)) {
        found.set(name, cookieValue);
      }
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [name, cookieValue] of Object.entries(value)) {
      if (typeof cookieValue === 'string') found.set(name, cookieValue);
    }
  }
  return found;
}

function fromHeader(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const part of text.replace(/^cookie:\s*/i, '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    found.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1'));
  }
  return found;
}

function parseText(text: string): Map<string, string> {
  try {
    return fromJson(JSON.parse(text));
  } catch {
    return fromHeader(text);
  }
}

export function parseCookieFile(text: string): CookieParseResult {
  const found = parseText(text.trim());
  const authToken = found.get('auth_token');
  const ct0 = found.get('ct0');
  if (!authToken || !ct0) {
    const missing: Array<'auth_token' | 'ct0'> = [];
    if (!authToken) missing.push('auth_token');
    if (!ct0) missing.push('ct0');
    return { ok: false, missing };
  }
  const twid = found.get('twid');
  return { ok: true, cookies: { authToken, ct0, ...(twid ? { twid } : {}) } };
}
