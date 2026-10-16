import { describe, expect, it } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReachloopError } from '../src/core/errors';
import { chromeSignIn, findChrome } from '../src/signin/chrome';

// External Chrome is deliberately opt-in. Run REACHLOOP_TEST_CHROME=1 bun test
// test/signin.test.ts (optionally set REACHLOOP_CHROME). Opting in requires a
// working installation: startup errors and missing Chrome fail, never skip.
const realChromeEnabled = process.env.REACHLOOP_TEST_CHROME === '1';
const chrome = realChromeEnabled ? await findChrome(process.env) : null;

type Command = { id: number; method: string };
const fakeCookies = [
  { name: 'auth_token', value: 'tok-1', domain: '.x.com' },
  { name: 'ct0', value: 'csrf-1', domain: 'login.x.com' },
  { name: 'twid', value: 'u%3D77', domain: '.twitter.com' },
  // Suffix lookalikes must not override cookies from allowed domains.
  { name: 'auth_token', value: 'wrong-domain', domain: 'notx.com' },
  { name: 'ct0', value: 'wrong-domain', domain: 'x.com.evil.invalid' },
];

async function withFakeChrome(
  onCommand: (ws: ServerWebSocket<undefined>, command: Command) => void,
  check: (signIn: ReturnType<typeof chromeSignIn>, commands: string[]) => Promise<void>,
  handshake: 'upgrade' | 'reject' | 'stall' = 'upgrade',
): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rl-signin-fake-'));
  const commands: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (handshake === 'stall') return new Promise<Response>(() => {});
      if (handshake === 'upgrade' && server.upgrade(request)) return;
      return new Response('Not a WebSocket', { status: 503 });
    },
    websocket: {
      message(ws: ServerWebSocket<undefined>, message) {
        const command = JSON.parse(String(message)) as Command;
        commands.push(command.method);
        onCommand(ws, command);
      },
    },
  });
  const fakeChrome = path.join(tmp, 'chrome');
  const previousTmp = process.env.TMPDIR;
  try {
    await Bun.write(fakeChrome, `#!/bin/sh
for arg in "$@"; do
  case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}" ;; esac
done
printf '${server.port}\n/devtools/browser/fake\n' > "$profile/DevToolsActivePort"
exec /bin/sleep 60
`);
    await chmod(fakeChrome, 0o755);
    process.env.TMPDIR = tmp;
    await check(chromeSignIn({}, { chromePath: fakeChrome }), commands);
    expect((await readdir(tmp)).filter((name) => name.startsWith('reachloop-signin-'))).toEqual([]);
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    server.stop(true);
    await rm(tmp, { recursive: true, force: true });
  }
}

async function expectSignInFailure(signIn: ReturnType<typeof chromeSignIn>, timeoutMs: number, message: string, maxMs = 2000) {
  const started = Date.now();
  const failure = await signIn({ timeoutMs }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ReachloopError);
  expect((failure as ReachloopError).code).toBe('SIGN_IN_FAILED');
  expect((failure as ReachloopError).message).toContain(message);
  expect((failure as ReachloopError).message).not.toContain('fake-secret');
  expect(Date.now() - started).toBeLessThan(maxMs);
}


describe('browser sign-in', () => {
  it('reads only allowed cookies, ignores events, and preserves success when Chrome closes without replying', async () => {
    await withFakeChrome((ws, command) => {
      if (command.method === 'Browser.close') { ws.close(); return; }
      ws.send(JSON.stringify({ method: 'Browser.event', params: {} }));
      ws.send(JSON.stringify({ id: command.id + 100, result: {} }));
      ws.send(JSON.stringify({ id: command.id, result: { cookies: fakeCookies } }));
    }, async (signIn, commands) => {
      expect(await signIn({ timeoutMs: 3000 })).toEqual({ authToken: 'tok-1', ct0: 'csrf-1', twid: 'u%3D77' });
      expect(commands).toEqual(['Storage.getCookies', 'Browser.close']);
    });
  });

  it('rejects a pending command immediately when the connection closes', async () => {
    await withFakeChrome((ws) => ws.close(), async (signIn) => {
      await expectSignInFailure(signIn, 30_000, 'connection to Chrome was closed');
    });
  });

  it('reports protocol errors without exposing their response payload', async () => {
    await withFakeChrome((ws, command) => {
      ws.send(JSON.stringify({ id: command.id, error: { code: -32000, message: 'fake-secret' } }));
    }, async (signIn) => {
      await expectSignInFailure(signIn, 3000, 'Chrome rejected a sign-in command');
    });
  });

  it('rejects malformed protocol data instead of throwing from the message handler', async () => {
    await withFakeChrome((ws) => ws.send('not json'), async (signIn) => {
      await expectSignInFailure(signIn, 3000, 'invalid protocol response');
    });
  });

  it('fails promptly on a WebSocket handshake error', async () => {
    await withFakeChrome(() => {}, async (signIn) => {
      await expectSignInFailure(signIn, 30_000, 'Could not talk to Chrome');
    }, 'reject');
  });

  it('bounds a stalled WebSocket handshake by the overall sign-in deadline', async () => {
    await withFakeChrome(() => {}, async (signIn) => {
      await expectSignInFailure(signIn, 1500, 'Timed out connecting to Chrome', 3500);
    }, 'stall');
  });

  it('bounds a silent command by the overall sign-in deadline', async () => {
    await withFakeChrome(() => {}, async (signIn) => {
      await expectSignInFailure(signIn, 1500, 'Timed out waiting for Chrome', 3500);
    });
  });

  it('also caps individual commands when the overall deadline is much longer', async () => {
    await withFakeChrome(() => {}, async (signIn) => {
      await expectSignInFailure(signIn, 30_000, 'Timed out waiting for Chrome', 8000);
    });
  }, 10_000);

  it('bounds best-effort browser shutdown without losing successful cookies', async () => {
    await withFakeChrome((ws, command) => {
      if (command.method === 'Storage.getCookies') ws.send(JSON.stringify({ id: command.id, result: { cookies: fakeCookies } }));
    }, async (signIn) => {
      const started = Date.now();
      expect(await signIn({ timeoutMs: 30_000 })).toEqual({ authToken: 'tok-1', ct0: 'csrf-1', twid: 'u%3D77' });
      // Allow process startup/cleanup scheduling on loaded runners while still
      // proving shutdown is bounded well below the 30-second sign-in deadline
      expect(Date.now() - started).toBeLessThan(6000);
    });
  }, 10_000);

  it('removes the temporary profile when spawning Chrome fails', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'rl-signin-spawn-'));
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      const signIn = chromeSignIn({}, { chromePath: path.join(tmp, 'does-not-exist') });
      await expectSignInFailure(signIn, 30_000, 'Could not start Chrome');
      expect(await readdir(tmp)).toEqual([]);
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it.if(realChromeEnabled)(
    'reads the session cookies a real Chrome receives after the person signs in, and leaves no browser profile behind',
    async () => {
      expect(chrome).not.toBeNull();
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
    120_000,
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
