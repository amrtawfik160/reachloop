import { Database } from 'bun:sqlite';
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
    expect(init.json.data.notice).toContain('50');
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
    expect(added.json.data).toMatchObject({ handle: '@acme', status: 'active', signIn: 'cookies', dmToday: '0/50', replyOnly: false, created: true });
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
    await h.run('limits', 'set', '@acme', '--dm', '83', '--reply-only', 'on');
    const again = await h.run('account', 'add', '--cookies-file', file);
    expect(again.json.data).toMatchObject({ created: false, dmToday: '0/83', replyOnly: true });
    expect((await h.run('limits', 'show', '@acme')).json.data).toMatchObject({ capDm: 83, replyOnly: true });
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
  it('persists toggles separately or together, allows zero, exposes account settings and logs changes', async () => {
    const h = await harness();
    await h.run('init');
    await h.run('account', 'add', '--cookies-file', await h.cookieFile(h.x.signIn('101', 'acme')));
    expect((await h.run('limits', 'set', '@acme', '--reply-only', 'on')).json.data).toMatchObject({ capDm: 50, replyOnly: true });
    expect((await h.run('limits', 'show', '@acme')).json.data.replyOnly).toBe(true);
    expect((await h.run('account', 'show', '@acme')).json.data.replyOnly).toBe(true);
    expect((await h.run('account', 'list')).json.data[0].replyOnly).toBe(true);
    expect((await h.run('limits', 'set', '@acme', '--dm', '0')).json.data).toMatchObject({ capDm: 0, replyOnly: true });
    expect((await h.run('limits', 'set', '@acme', '--dm', '250', '--reply-only', 'off')).json.data).toMatchObject({ capDm: 250, replyOnly: false });
    expect((await h.run('limits', 'show', '@acme')).json.data).toMatchObject({ capDm: 250, replyOnly: false });
    const db = new Database(path.join(h.home, 'reachloop.db'), { readonly: true });
    expect(db.query("SELECT kind, data_json FROM events WHERE kind = 'reply_only_changed' ORDER BY id").all()).toEqual([
      { kind: 'reply_only_changed', data_json: '{"replyOnly":true}' },
      { kind: 'reply_only_changed', data_json: '{"replyOnly":false}' },
    ]);
    db.close();
  });

  it('rejects absent or invalid settings without changing either setting or writing events', async () => {
    const h = await harness();
    await h.run('init');
    await h.run('account', 'add', '--cookies-file', await h.cookieFile(h.x.signIn('101', 'acme')));
    await h.run('limits', 'set', '@acme', '--dm', '75', '--reply-only', 'on');
    const file = path.join(h.home, 'reachloop.db');
    const before = new Database(file, { readonly: true });
    const events = before.query('SELECT * FROM events ORDER BY id').all();
    before.close();
    for (const args of [[], ['--reply-only', 'maybe'], ['--dm', '100', '--reply-only', 'bad'], ['--dm', '251', '--reply-only', 'off'], ['--dm', '-1', '--reply-only', 'off'], ['--dm', '1.5'], ['--dm', 'NaN'], ['--dm', ''], ['--dm', '  ']]) {
      const result = await h.run('limits', 'set', '@acme', ...args);
      expect(result.code).not.toBe(0);
      expect((await h.run('limits', 'show', '@acme')).json.data).toMatchObject({ capDm: 75, replyOnly: true });
    }
    const after = new Database(file, { readonly: true });
    expect(after.query('SELECT * FROM events ORDER BY id').all()).toEqual(events);
    after.close();
  });

  it('rolls back both settings and audit events if any write fails', async () => {
    const h = await harness();
    await h.run('init');
    await h.run('account', 'add', '--cookies-file', await h.cookieFile(h.x.signIn('101', 'acme')));
    const file = path.join(h.home, 'reachloop.db');
    const db = new Database(file);
    const events = db.query('SELECT * FROM events ORDER BY id').all();
    db.exec("CREATE TRIGGER fail_reply_only_log BEFORE INSERT ON events WHEN NEW.kind = 'reply_only_changed' BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
    db.close();
    expect((await h.run('limits', 'set', '@acme', '--dm', '123', '--reply-only', 'on')).code).not.toBe(0);
    expect((await h.run('limits', 'show', '@acme')).json.data).toMatchObject({ capDm: 50, replyOnly: false });
    const check = new Database(file, { readonly: true });
    expect(check.query('SELECT * FROM events ORDER BY id').all()).toEqual(events);
    check.close();
  });

  it('defaults to 50 DMs a day and outbound allowed, accepts 250 and refuses 251', async () => {
    const h = await harness();
    await h.run('init');
    await h.run('account', 'add', '--cookies-file', await h.cookieFile(h.x.signIn('101', 'acme')));
    expect((await h.run('limits', 'show', '@acme')).json.data).toMatchObject({ capDm: 50, hardMax: 250, remaining: 50, replyOnly: false });
    const tooHigh = await h.run('limits', 'set', '@acme', '--dm', '251');
    expect(tooHigh.code).toBe(6);
    expect(tooHigh.json.error?.code).toBe('CAP_ABOVE_MAX');
    expect((await h.run('limits', 'set', '@acme', '--dm', '250')).json.data.capDm).toBe(250);
  });
});
