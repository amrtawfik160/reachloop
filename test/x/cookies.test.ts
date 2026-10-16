import { describe, expect, it } from 'bun:test';
import { parseCookieFile } from '../../src/x/cookies';

describe('parseCookieFile', () => {
  it('reads a flat object of cookie values', () => {
    expect(parseCookieFile('{"auth_token":"a1","ct0":"c1","twid":"u%3D42"}')).toEqual({
      ok: true,
      cookies: { authToken: 'a1', ct0: 'c1', twid: 'u%3D42' },
    });
  });

  it('reads a browser-extension export and ignores cookies for other sites', () => {
    const exported = JSON.stringify([
      { name: 'auth_token', value: 'other', domain: '.example.com' },
      { name: 'auth_token', value: 'a2', domain: '.x.com' },
      { name: 'ct0', value: 'c2', domain: 'x.com' },
      { name: 'twid', value: 'u%3D7', domain: '.twitter.com' },
    ]);
    expect(parseCookieFile(exported)).toEqual({
      ok: true,
      cookies: { authToken: 'a2', ct0: 'c2', twid: 'u%3D7' },
    });
  });

  it('reports which required cookie is missing', () => {
    expect(parseCookieFile('{"auth_token":"a1"}')).toEqual({ ok: false, missing: ['ct0'] });
  });

  it('reads a copied Cookie header', () => {
    expect(parseCookieFile('guest_id=g; auth_token=a3; ct0=c3; twid="u=9"')).toEqual({
      ok: true,
      cookies: { authToken: 'a3', ct0: 'c3', twid: 'u=9' },
    });
  });

  it('reports both cookies missing for unrelated text', () => {
    expect(parseCookieFile('hello')).toEqual({ ok: false, missing: ['auth_token', 'ct0'] });
  });
});
