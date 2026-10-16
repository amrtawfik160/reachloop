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

type CdpSession = { call: (method: string, timeoutMs?: number) => Promise<unknown>; close: () => void };
type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: ReachloopError) => void;
  timer: ReturnType<typeof setTimeout>;
};

// Bound both the handshake and every command, including commands sent during
// shutdown. Closing or failing the socket must settle all outstanding work.
function cdp(url: string, deadline: number): Promise<CdpSession> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      reject(new ReachloopError('SIGN_IN_FAILED', 'Could not connect to Chrome.'));
      return;
    }
    const pending = new Map<number, PendingCall>();
    let nextId = 1;
    let failure: ReachloopError | null = null;
    const closeSocket = () => {
      try { socket.close(); } catch { /* Already closed or still connecting. */ }
    };
    const fail = (error: ReachloopError) => {
      if (failure) return;
      failure = error;
      clearTimeout(connectTimer);
      reject(error);
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(error);
      }
      pending.clear();
      closeSocket();
    };
    const connectTimer = setTimeout(
      () => fail(new ReachloopError('SIGN_IN_FAILED', 'Timed out connecting to Chrome.')),
      Math.max(0, Math.min(5000, deadline - Date.now())),
    );
    socket.onmessage = (event) => {
      let message: { id?: number; result?: unknown; error?: unknown };
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid message');
        message = parsed;
      } catch {
        fail(new ReachloopError('SIGN_IN_FAILED', 'Chrome sent an invalid protocol response.'));
        return;
      }
      if (message.id === undefined) return; // Unsolicited protocol event.
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error !== undefined) {
        call.reject(new ReachloopError('SIGN_IN_FAILED', 'Chrome rejected a sign-in command.'));
      } else {
        call.resolve(message.result);
      }
    };
    socket.onerror = () => fail(new ReachloopError('SIGN_IN_FAILED', 'Could not talk to Chrome.'));
    socket.onclose = () => fail(new ReachloopError('SIGN_IN_FAILED', 'The connection to Chrome was closed.'));
    socket.onopen = () => {
      clearTimeout(connectTimer);
      if (failure) return;
      resolve({
        call: (method, timeoutMs = 5000) => new Promise((done, failed) => {
          if (failure) { failed(failure); return; }
          const remaining = Math.min(timeoutMs, deadline - Date.now());
          if (remaining <= 0) {
            failed(new ReachloopError('SIGN_IN_FAILED', 'Sign-in did not finish in time.'));
            return;
          }
          const id = nextId++;
          const timer = setTimeout(() => {
            fail(new ReachloopError('SIGN_IN_FAILED', 'Timed out waiting for Chrome to respond.'));
          }, remaining);
          pending.set(id, { resolve: done, reject: failed, timer });
          try {
            socket.send(JSON.stringify({ id, method }));
          } catch {
            fail(new ReachloopError('SIGN_IN_FAILED', 'Could not send a command to Chrome.'));
          }
        }),
        close: () => fail(new ReachloopError('SIGN_IN_FAILED', 'The connection to Chrome was closed.')),
      });
    };
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
    const deadline = Date.now() + timeoutMs;
    let browser: ChromeProcess | null = null;
    let session: CdpSession | null = null;
    try {
      try {
        browser = startChrome([chrome, ...args]);
      } catch {
        throw new ReachloopError('SIGN_IN_FAILED', 'Could not start Chrome.', {
          hint: 'Check REACHLOOP_CHROME points to an executable Chrome installation.',
        });
      }
      const { proc } = browser;
      session = await cdp(await devToolsUrl(profile, Math.min(deadline, Date.now() + 20_000), browser), deadline);
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
        await Bun.sleep(Math.max(0, Math.min(1000, deadline - Date.now())));
      }
      throw new ReachloopError('SIGN_IN_FAILED', 'Sign-in did not finish in time.', { hint: 'Run the command again.' });
    } finally {
      if (session) {
        // Chrome can close the socket before acknowledging Browser.close. A
        // failed best-effort shutdown must not mask sign-in's result or error.
        try { await session.call('Browser.close', 2000); } catch { /* Best effort. */ }
        session.close();
      }
      try {
        if (browser) {
          browser.proc.kill('SIGKILL');
          await browser.proc.exited;
        }
      } finally {
        await removeProfile(profile);
      }
    }
  };
}
