import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Subprocess } from 'bun';
import { ReachloopError } from '../core/errors';
import type { TwitterAuthCookies } from '../x/client';

export type BrowserSignIn = (args: { timeoutMs: number }) => Promise<TwitterAuthCookies>;

export type ChromeSignInOptions = {
  chromePath?: string;
  loginUrl?: string;
  cookieDomains?: string[];
  headless?: boolean;
};

const MAC_CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
const LINUX_CHROMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

export async function findChrome(env: Record<string, string | undefined>): Promise<string | null> {
  if (env.REACHLOOP_CHROME) return env.REACHLOOP_CHROME;
  if (process.platform === 'darwin') {
    for (const candidate of MAC_CHROMES) if (await Bun.file(candidate).exists()) return candidate;
    return null;
  }
  for (const name of LINUX_CHROMES) {
    const found = Bun.which(name);
    if (found) return found;
  }
  return null;
}

type ChromeProcess = { proc: Subprocess; stderrDone: Promise<void>; stderrTail: () => string };

// Keeps only the end of Chrome's error output, so a failed start can say why.
function startChrome(command: string[]): ChromeProcess {
  const proc = Bun.spawn(command, { stdout: 'ignore', stderr: 'pipe' });
  let tail = '';
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      tail = (tail + decoder.decode(chunk, { stream: true })).slice(-4000);
    }
  })().catch(() => {});
  const stderrTail = () =>
    tail
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3)
      .join(' | ')
      .slice(-400);
  return { proc, stderrDone, stderrTail };
}

async function startFailure(chrome: ChromeProcess, summary: string): Promise<ReachloopError> {
  await Promise.race([chrome.stderrDone, Bun.sleep(1000)]);
  const lines = chrome.stderrTail();
  return new ReachloopError('SIGN_IN_FAILED', lines ? `${summary} Chrome said: ${lines}` : summary, {
    hint: 'Check that Chrome opens on this computer, or set REACHLOOP_CHROME to another Chrome. You can also use: reachloop account add --cookies-file <file>',
  });
}

async function devToolsUrl(profile: string, deadline: number, chrome: ChromeProcess): Promise<string> {
  while (Date.now() < deadline) {
    const text = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    const [port, browserPath] = text.split('\n');
    if (port && browserPath) return `ws://127.0.0.1:${port.trim()}${browserPath.trim()}`;
    if (chrome.proc.exitCode !== null) {
      throw await startFailure(chrome, `Chrome stopped with exit code ${chrome.proc.exitCode} before it started.`);
    }
    await Bun.sleep(100);
  }
  throw await startFailure(chrome, 'Chrome did not start in time.');
}

type CdpCookie = { name: string; value: string; domain: string };

function cdp(url: string): Promise<{ call: (method: string) => Promise<unknown>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map<number, (value: unknown) => void>();
    let nextId = 1;
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
      if (message.id !== undefined) pending.get(message.id)?.(message.result);
    };
    socket.onerror = () => reject(new ReachloopError('SIGN_IN_FAILED', 'Could not talk to Chrome.'));
    socket.onopen = () =>
      resolve({
        call: (method) =>
          new Promise((done) => {
            const id = nextId++;
            pending.set(id, done);
            socket.send(JSON.stringify({ id, method }));
          }),
        close: () => socket.close(),
      });
  });
}

// The profile holds the new X session. Chrome's helper processes can still
// write to it for a moment after the browser exits, so delete until it stays gone.
async function removeProfile(profile: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
    await Bun.sleep(250);
    if (!existsSync(profile)) return;
  }
}

function matches(domain: string, allowed: string[]): boolean {
  const bare = domain.replace(/^\./, '');
  return allowed.some((d) => bare === d || bare.endsWith(`.${d}`));
}

// Opens a separate Chrome profile on the X sign-in page. The person types their
// own password; Reachloop never drives the page. It only reads the session
// cookies once they exist, then closes the window.
export function chromeSignIn(env: Record<string, string | undefined>, options: ChromeSignInOptions = {}): BrowserSignIn {
  return async ({ timeoutMs }) => {
    const chrome = options.chromePath ?? (await findChrome(env));
    if (!chrome) {
      throw new ReachloopError('SIGN_IN_FAILED', 'Google Chrome or Chromium is not installed.', {
        hint: 'Install Google Chrome, or set REACHLOOP_CHROME to its path. You can also use: reachloop account add --cookies-file <file>',
      });
    }
    const domains = options.cookieDomains ?? ['x.com', 'twitter.com'];
    const profile = await mkdtemp(path.join(os.tmpdir(), 'reachloop-signin-'));
    const args = [
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      ...(options.headless ? ['--headless=new'] : []),
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      options.loginUrl ?? 'https://x.com/i/flow/login',
    ];
    const browser = startChrome([chrome, ...args]);
    const { proc } = browser;
    const deadline = Date.now() + timeoutMs;
    let session: Awaited<ReturnType<typeof cdp>> | null = null;
    try {
      session = await cdp(await devToolsUrl(profile, Math.min(deadline, Date.now() + 20_000), browser));
      while (Date.now() < deadline) {
        if (proc.exitCode !== null) {
          throw new ReachloopError('SIGN_IN_FAILED', 'The sign-in window was closed before sign-in finished.');
        }
        const result = (await session.call('Storage.getCookies')) as { cookies?: CdpCookie[] } | undefined;
        const found = new Map(
          (result?.cookies ?? []).filter((cookie) => matches(cookie.domain, domains)).map((cookie) => [cookie.name, cookie.value]),
        );
        const authToken = found.get('auth_token');
        const ct0 = found.get('ct0');
        const twid = found.get('twid');
        if (authToken && ct0 && twid) return { authToken, ct0, twid };
        await Bun.sleep(1000);
      }
      throw new ReachloopError('SIGN_IN_FAILED', 'Sign-in did not finish in time.', { hint: 'Run the command again.' });
    } finally {
      if (session) {
        await Promise.race([session.call('Browser.close'), Bun.sleep(2000)]);
        session.close();
      }
      proc.kill();
      await proc.exited;
      await removeProfile(profile);
    }
  };
}
