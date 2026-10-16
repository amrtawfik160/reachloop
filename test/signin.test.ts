import { describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReachloopError } from '../src/core/errors';
import { chromeSignIn, findChrome } from '../src/signin/chrome';

const chrome = await findChrome(process.env);

describe('browser sign-in', () => {
  it.if(chrome !== null)(
    'reads the session cookies a real Chrome receives after the person signs in, and leaves no browser profile behind',
    async () => {
      let served = 0;
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request) {
          served++;
          const signedIn = new URL(request.url).pathname === '/home';
          const headers = new Headers({ 'content-type': 'text/html' });
          if (signedIn) {
            for (const cookie of ['auth_token=tok-1', 'ct0=csrf-1', 'twid=u%3D77', 'other=x']) headers.append('set-cookie', `${cookie}; Path=/`);
          }
          const body = signedIn ? 'signed in' : '<script>setTimeout(() => location.href = "/home", 1500)</script>waiting';
          return new Response(body, { headers });
        },
      });
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'rl-signin-tmp-'));
      const previousTmp = process.env.TMPDIR;
      process.env.TMPDIR = tmp;
      try {
        const signIn = chromeSignIn(process.env, {
          loginUrl: `http://127.0.0.1:${server.port}/login`,
          cookieDomains: ['127.0.0.1'],
          headless: true,
        });
        for (let attempt = 0; attempt < 3; attempt++) {
          expect(await signIn({ timeoutMs: 30_000 })).toEqual({ authToken: 'tok-1', ct0: 'csrf-1', twid: 'u%3D77' });
        }
        expect(served).toBeGreaterThanOrEqual(6);
        await Bun.sleep(1500);
        expect((await readdir(tmp)).filter((name) => name.startsWith('reachloop-signin-'))).toEqual([]);
      } finally {
        if (previousTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmp;
        server.stop(true);
        await rm(tmp, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it('stops waiting as soon as Chrome exits and reports its exit code and last error lines', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'rl-signin-crash-'));
    const fakeChrome = path.join(tmp, 'chrome');
    await Bun.write(fakeChrome, '#!/bin/sh\necho "starting" >&2\necho "FATAL: no usable sandbox" >&2\nexit 3\n');
    await chmod(fakeChrome, 0o755);
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      const signIn = chromeSignIn(process.env, { chromePath: fakeChrome, headless: true });
      const started = Date.now();
      const failure = await signIn({ timeoutMs: 30_000 }).catch((err: unknown) => err);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(failure).toBeInstanceOf(ReachloopError);
      expect((failure as ReachloopError).code).toBe('SIGN_IN_FAILED');
      expect((failure as ReachloopError).message).toContain('exit code 3');
      expect((failure as ReachloopError).message).toContain('FATAL: no usable sandbox');
      expect((await readdir(tmp)).filter((name) => name.startsWith('reachloop-signin-'))).toEqual([]);
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
