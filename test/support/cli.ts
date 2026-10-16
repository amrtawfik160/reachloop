import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../../src/cli/run';
import type { TwitterAuthCookies } from '../../src/x/client';
import { FakeX } from './fake-x';

export type Envelope = {
  ok: boolean;
  data?: any;
  meta?: { total: number; returned: number; next?: string };
  warnings?: string[];
  hints?: string[];
  error?: { code: string; message: string; retryable: boolean; hint?: string; retryAfter?: number };
};

export async function harness() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'reachloop-test-'));
  const x = new FakeX();
  let browserCookies: TwitterAuthCookies | null = null;
  let clock = new Date('2026-10-16T10:00:00').getTime();
  const env = { REACHLOOP_HOME: home, REACHLOOP_SECRET_STORE: 'file', HOME: home };
  x.now = () => clock;

  async function run(...argv: string[]): Promise<{ code: number; out: string; err: string; json: Envelope }> {
    let out = '';
    let err = '';
    const code = await runCli(
      [...argv, '--json'],
      {
        env,
        connect: x.connect,
        signIn: async () => {
          if (!browserCookies) throw new Error('no browser sign-in prepared');
          return browserCookies;
        },
        now: () => clock,
      },
      { stdout: (text) => (out += text), stderr: (text) => (err += text) },
    );
    return { code, out, err, json: JSON.parse(out) as Envelope };
  }

  async function cookieFile(cookies: TwitterAuthCookies): Promise<string> {
    const file = path.join(home, `cookies-${cookies.authToken}.json`);
    await Bun.write(file, JSON.stringify({ auth_token: cookies.authToken, ct0: cookies.ct0, twid: cookies.twid }));
    return file;
  }

  return {
    home,
    x,
    run,
    cookieFile,
    preparedBrowser: (cookies: TwitterAuthCookies) => {
      browserCookies = cookies;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}
