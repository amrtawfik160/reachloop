import { describe, expect, it } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { harness } from './support/cli';

describe('setup', () => {
  it('asks for init before any other command, then creates the database and shows the X rules once', async () => {
    const h = await harness();
    const before = await h.run('account', 'list');
    expect(before.code).toBe(1);
    expect(before.json.error?.code).toBe('NOT_INITIALIZED');
    expect(before.json.error?.hint).toBe('reachloop init');

    const init = await h.run('init');
    expect(init.code).toBe(0);
    expect(init.json.data.notice).toContain('reply-only');
    expect((await h.run('account', 'list')).json).toMatchObject({ ok: true, data: [], meta: { total: 0 } });
  });

  it('rejects an unknown flag with exit code 2', async () => {
    const h = await harness();
    await h.run('init');
    const result = await h.run('lead', 'list', '--colour', 'red');
    expect(result.code).toBe(2);
    expect(result.json.error?.code).toBe('USAGE');
  });

  it('installs the skill for both Claude Code and Codex', async () => {
    const h = await harness();
    const result = await h.run('skill', 'install', '--agent', 'all');
    expect(result.code).toBe(0);
    for (const dir of [path.join(h.home, '.claude', 'skills', 'reachloop'), path.join(h.home, '.codex', 'skills', 'reachloop')]) {
      expect(await readFile(path.join(dir, 'SKILL.md'), 'utf8')).toStartWith('---\nname: reachloop\n');
      expect((await readdir(path.join(dir, 'reference'))).sort()).toEqual(['commands.md', 'modes-and-limits.md']);
    }
  });
});

describe('accounts', () => {
  it('adds an account from a cookie file and keeps the cookies out of the database and output', async () => {
    const h = await harness();
    await h.run('init');
    const cookies = h.x.signIn('101', 'acme');
    const added = await h.run('account', 'add', '--cookies-file', await h.cookieFile(cookies));
    expect(added.code).toBe(0);
    expect(added.json.data).toMatchObject({ handle: '@acme', status: 'active', signIn: 'cookies', dmToday: '0/50', created: true });
    expect(added.out).not.toContain(cookies.authToken);
    const db = await readFile(path.join(h.home, 'reachloop.db'));
    expect(db.includes(Buffer.from(cookies.authToken))).toBe(false);
    expect((await h.run('account', 'list')).json.data.map((a: { handle: string }) => a.handle)).toEqual(['@acme']);
  });

  it('refuses cookies that X does not accept', async () => {
    const h = await harness();
    await h.run('init');
    const file = await h.cookieFile({ authToken: 'stale', ct0: 'c', twid: 'u%3D1' });
    const result = await h.run('account', 'add', '--cookies-file', file);
    expect(result.code).toBe(4);
    expect(result.json.error?.code).toBe('SESSION_EXPIRED');
    expect((await h.run('account', 'list')).json.data).toEqual([]);
  });

  it('names the missing cookie when the file is incomplete', async () => {
    const h = await harness();
    await h.run('init');
    const file = path.join(h.home, 'partial.json');
    await Bun.write(file, '{"auth_token":"a"}');
    const result = await h.run('account', 'add', '--cookies-file', file);
    expect(result.code).toBe(2);
    expect(result.json.error?.message).toContain('ct0');
  });

  it('signs in through the browser and records the method', async () => {
    const h = await harness();
    await h.run('init');
    h.preparedBrowser(h.x.signIn('202', 'brand'));
    const result = await h.run('account', 'login', '--browser');
    expect(result.code).toBe(0);
    expect(result.json.data).toMatchObject({ handle: '@brand', signIn: 'browser' });
  });

  it('warns when a fourth account is added, because all accounts share one IP', async () => {
    const h = await harness();
    await h.run('init');
    const warningsAt: number[] = [];
    for (const n of [1, 2, 3, 4]) {
      const result = await h.run('account', 'add', '--cookies-file', await h.cookieFile(h.x.signIn(String(n), `acct${n}`)));
      if (result.json.warnings?.length) warningsAt.push(n);
    }
    expect(warningsAt).toEqual([4]);
  });

  it('re-adding the same X account updates it instead of duplicating it', async () => {
    const h = await harness();
    await h.run('init');
    const file = await h.cookieFile(h.x.signIn('101', 'acme'));
    await h.run('account', 'add', '--cookies-file', file);
    const again = await h.run('account', 'add', '--cookies-file', file);
    expect(again.json.data.created).toBe(false);
    expect((await h.run('account', 'list')).json.meta?.total).toBe(1);
  });

  it('removes an account only with --yes', async () => {
    const h = await harness();
    await h.run('init');
    await h.run('account', 'add', '--cookies-file', await h.cookieFile(h.x.signIn('101', 'acme')));
    expect((await h.run('account', 'remove', '@acme')).code).toBe(6);
    expect((await h.run('account', 'remove', '@acme', '--yes')).code).toBe(0);
    expect((await h.run('account', 'show', '@acme')).code).toBe(3);
  });
});

describe('limits', () => {
  it('defaults to 50 DMs a day and refuses a cap above 200', async () => {
    const h = await harness();
    await h.run('init');
    await h.run('account', 'add', '--cookies-file', await h.cookieFile(h.x.signIn('101', 'acme')));
    expect((await h.run('limits', 'show', '@acme')).json.data).toMatchObject({ capDm: 50, hardMax: 200, remaining: 50 });
    const tooHigh = await h.run('limits', 'set', '@acme', '--dm', '201');
    expect(tooHigh.code).toBe(6);
    expect(tooHigh.json.error?.code).toBe('CAP_ABOVE_MAX');
    expect((await h.run('limits', 'set', '@acme', '--dm', '200')).json.data.capDm).toBe(200);
  });
});
