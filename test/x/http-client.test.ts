import { describe, expect, it } from 'bun:test';
import type { CycleTLSClient, CycleTLSResponse } from 'cycletls';
import { CHROME_120_HTTP2, CHROME_120_JA3, CHROME_120_USER_AGENT, createImpersonatedHttpClient, type HttpClientDependencies } from '../../src/x/http-client';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(): CycleTLSResponse {
  return { status: 200, headers: {}, data: '{"ok":true}', finalUrl: 'https://example.test/result' } as CycleTLSResponse;
}
function client(request: (...args: Parameters<CycleTLSClient>) => Promise<CycleTLSResponse> = async () => response(), exit: () => Promise<undefined> = async () => undefined): CycleTLSClient {
  return Object.assign(request, { exit }) as CycleTLSClient;
}
function setup(initialize: HttpClientDependencies['initialize'], extras: Partial<HttpClientDependencies> = {}) {
  let port = 41000;
  return createImpersonatedHttpClient({ initialize, resolveHelper: async () => undefined, allocatePort: async () => ++port,
    initializationTimeoutMs: 40, shutdownTimeoutMs: 10, ...extras });
}
const url = 'https://example.test/offline-only';
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('HTTP transport lifecycle (mocked, no network)', () => {
  it('shares initialization and preserves Chrome fingerprint, options and response', async () => {
    const started = deferred<CycleTLSClient>();
    const calls: Parameters<CycleTLSClient>[] = [];
    const ports: number[] = [];
    let exits = 0;
    const http = setup(async (options) => { ports.push(options!.port!); expect(options!.autoExit).toBe(true); return started.promise; });
    const first = http.fetchImpersonated(url, { method: 'POST', headers: { cookie: 'fake-cookie' }, body: 'payload', timeoutMs: 500 });
    const second = http.fetchImpersonated(url, { timeoutMs: 500 });
    await tick();
    expect(ports).toEqual([41001]);
    started.resolve(client(async (...args) => { calls.push(args); return response(); }, async () => { exits++; return undefined; }));
    const result = await first;
    await second;
    expect(calls[0]![1]).toMatchObject({ ja3: CHROME_120_JA3, http2Fingerprint: CHROME_120_HTTP2,
      userAgent: CHROME_120_USER_AGENT, body: 'payload', timeout: 1, headers: { cookie: 'fake-cookie' } });
    expect(calls[0]![1].headerOrder).toContain('cookie');
    expect(calls[0]![1].insecureSkipVerify).toBeUndefined();
    expect(calls[0]![2]).toBe('post');
    expect(result.ok).toBe(true);
    expect(result.headers).toBeInstanceOf(Headers);
    expect(await result.json()).toEqual({ ok: true });
    await http.disposeHttpClient();
    expect(exits).toBe(1);
  });
  it('retries rejected initialization on a fresh private port', async () => {
    const ports: number[] = [];
    let abandoned = 0;
    const http = setup(async (options) => {
      ports.push(options!.port!);
      if (ports.length === 1) throw new Error('startup failed');
      return client();
    }, { abandonInitialization: async () => { abandoned++; } });
    await expect(http.fetchImpersonated(url)).rejects.toThrow('startup failed');
    expect((await http.fetchImpersonated(url)).status).toBe(200);
    expect(ports).toEqual([41001, 41002]);
    expect(abandoned).toBe(1);
    await http.disposeHttpClient();
  });
  it('bounds hanging initialization and closes its late result', async () => {
    const late = deferred<CycleTLSClient>();
    let count = 0;
    let exits = 0;
    let abandoned = 0;
    const http = setup(async () => ++count === 1 ? late.promise : client(), {
      abandonInitialization: async () => { abandoned++; },
    });
    await expect(http.fetchImpersonated(url)).rejects.toThrow('initialization timed out');
    expect(abandoned).toBe(1);
    expect((await http.fetchImpersonated(url)).ok).toBe(true);
    late.resolve(client(undefined, async () => { exits++; return undefined; }));
    await tick();
    expect(exits).toBe(1);
    expect(count).toBe(2);
    await http.disposeHttpClient();
  });
  it('includes initialization in the total request deadline', async () => {
    const http = setup(async () => new Promise(() => {}), { initializationTimeoutMs: 100 });
    await expect(http.fetchImpersonated(url, { timeoutMs: 10 })).rejects.toThrow('HTTP request timed out');
    await http.disposeHttpClient();
  });
  it('bounds lost responses, closes the helper, and never retries a POST', async () => {
    let requests = 0;
    let exits = 0;
    const http = setup(async () => client(async () => { requests++; return new Promise(() => {}); }, async () => { exits++; return undefined; }));
    await expect(http.fetchImpersonated(url, { method: 'POST', timeoutMs: 10 })).rejects.toThrow('HTTP request timed out');
    await tick();
    expect(requests).toBe(1);
    expect(exits).toBe(1);
  });
  it('bounds hanging exit and permits a fresh client', async () => {
    let initializations = 0;
    const http = setup(async () => { initializations++; return client(undefined, () => new Promise(() => {})); });
    await http.fetchImpersonated(url);
    await http.disposeHttpClient();
    await http.fetchImpersonated(url);
    expect(initializations).toBe(2);
    await http.disposeHttpClient();
  });
  it('disposal cancels startup and closes the eventual result without sending', async () => {
    const late = deferred<CycleTLSClient>();
    let exits = 0;
    let requests = 0;
    const http = setup(async () => late.promise);
    const result = http.fetchImpersonated(url);
    const assertion = result.catch((error: Error) => error);
    await tick();
    await http.disposeHttpClient();
    expect((await assertion as Error).message).toContain('disposed');
    late.resolve(client(async () => { requests++; return response(); }, async () => { exits++; return undefined; }));
    await tick();
    expect(exits).toBe(1);
    expect(requests).toBe(0);
  });
  it('disposal cancels in-flight requests promptly', async () => {
    const http = setup(async () => client(() => new Promise(() => {})));
    const pending = http.fetchImpersonated(url);
    const assertion = pending.catch((error: Error) => error);
    await tick();
    await http.disposeHttpClient();
    expect((await assertion as Error).message).toContain('disposed');
  });
  it('handles late request rejection after its deadline', async () => {
    const request = deferred<CycleTLSResponse>();
    const http = setup(async () => client(() => request.promise, () => new Promise(() => {})));
    await expect(http.fetchImpersonated(url, { timeoutMs: 10 })).rejects.toThrow('timed out');
    request.reject(new Error('late failure'));
    await tick();
    await http.disposeHttpClient();
  });
  it('rejects invalid deadlines before starting a helper', async () => {
    let calls = 0;
    const http = setup(async () => { calls++; return client(); });
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(http.fetchImpersonated(url, { timeoutMs })).rejects.toThrow('positive finite');
    }
    expect(calls).toBe(0);
  });
  it('preserves health-check opt-out and soft rate limits', async () => {
    const http = setup(async () => client(async (_url, options) => {
      expect(options.ja3).toBeUndefined();
      expect(options.http2Fingerprint).toBeUndefined();
      return { ...response(), headers: { 'x-rate-limit-remaining': '0' } };
    }));
    const result = await http.fetchImpersonated(url, { disableJa3: true });
    expect(result.status).toBe(429);
    expect(result.ok).toBe(false);
    await http.disposeHttpClient();
  });
});
