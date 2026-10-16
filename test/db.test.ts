import { Database } from 'bun:sqlite';
import { MIGRATIONS } from '../src/db/migrations';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/db';

describe('database file', () => {
  it('is readable only by its owner, including the write-ahead log', async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'rl-db-')), 'home', 'reachloop.db');
    const db = openDb(file);
    db.query("INSERT INTO settings (key, value) VALUES ('k', 'v')").run();
    for (const name of [file, `${file}-wal`]) expect((await stat(name)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    db.close();
  });
});

async function tempDbFile(): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), 'rl-migration-')), 'reachloop.db');
}

function insertAccount(db: Database, id: number, cap: number): void {
  db.query(`INSERT INTO accounts (id, x_user_id, handle, status, sign_in, secret_ref, cap_dm, last_inbox_sync_at, created_at)
    VALUES (?, ?, ?, 'paused', 'browser', ?, ?, 1234, 1000)`)
    .run(id, `user-${id}`, `handle${id}`, `file:account:${id}`, cap);
}

const relatedTables = ['leads', 'lead_tags', 'searches', 'templates', 'conversations', 'messages', 'daily_usage', 'events', 'settings'];

function relatedRows(db: Database) {
  return Object.fromEntries(relatedTables.map((table) => [table, db.query(`SELECT * FROM ${table}`).all()]));
}

function versionOne(file: string): Database {
  const db = new Database(file);
  db.exec(MIGRATIONS[0] as string);
  db.exec('PRAGMA user_version = 1');
  for (const [id, cap] of [[11, 0], [22, 75], [33, 200]] as const) insertAccount(db, id, cap);
  db.exec(`
    INSERT INTO leads (id, x_user_id, handle, source, added_at) VALUES (8, 'lead8', 'lead8', 'csv', 1000);
    INSERT INTO lead_tags VALUES (8, 'warm');
    INSERT INTO searches (id, kind, query, account_id, created_at) VALUES (9, 'keyword', 'hello', 22, 1000);
    INSERT INTO templates VALUES (10, 'welcome', 'hello', 1000);
    INSERT INTO conversations VALUES (12, 22, 8, 'conv12', 1, 1, 1200);
    INSERT INTO messages VALUES (13, 12, 'in', 'hello', 'msg13', NULL, NULL, 'x', 1200);
    INSERT INTO messages VALUES (14, 12, 'out', 'reply', 'msg14', 'dedupe14', 'sent', 'reply', 1300);
    INSERT INTO daily_usage VALUES (22, '2026-10-16', 'dm', 3);
    INSERT INTO events VALUES (15, 1300, 'cli', 'sent', 22, 8, '{"safe":true}');
    INSERT INTO settings VALUES ('secret_backend', 'file');
  `);
  return db;
}

describe('account schema migrations', () => {
  it('creates a fresh schema with outbound enabled, cap 50, max 250 and checked reply-only values', async () => {
    const db = openDb(await tempDbFile());
    try {
      db.exec(`INSERT INTO accounts (x_user_id, handle, status, sign_in, secret_ref, created_at)
        VALUES ('1', 'fresh', 'active', 'cookies', 'file:fake', 1)`);
      expect(db.query('SELECT cap_dm, reply_only FROM accounts').get()).toEqual({ cap_dm: 50, reply_only: 0 });
      for (const cap of [0, 250]) expect(() => db.query('UPDATE accounts SET cap_dm = ?').run(cap)).not.toThrow();
      for (const cap of [-1, 251]) expect(() => db.query('UPDATE accounts SET cap_dm = ?').run(cap)).toThrow();
      for (const value of [0, 1]) expect(() => db.query('UPDATE accounts SET reply_only = ?').run(value)).not.toThrow();
      for (const value of [-1, 2, null]) expect(() => db.query('UPDATE accounts SET reply_only = ?').run(value)).toThrow();
      expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 2 });
      expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    } finally {
      db.close();
    }
  });

  it('preserves populated v1 accounts, custom caps, secrets and every child row across migration and reopening', async () => {
    const file = await tempDbFile();
    const old = versionOne(file);
    const accounts = old.query<Record<string, unknown>, []>('SELECT * FROM accounts ORDER BY id').all();
    const related = relatedRows(old);
    old.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const db = openDb(file);
      try {
        expect(db.query('SELECT * FROM accounts ORDER BY id').all()).toEqual(accounts.map((row) => ({ ...row, reply_only: 0 })));
        expect(relatedRows(db)).toEqual(related);
        expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
        expect(() => db.exec("INSERT INTO daily_usage VALUES (999, '2026-10-16', 'dm', 1)")).toThrow();
        expect(() => db.exec("INSERT INTO accounts (x_user_id, handle, status, sign_in, secret_ref, created_at) VALUES ('other', 'HANDLE22', 'active', 'cookies', 'fake', 1)")).toThrow();
      } finally {
        db.close();
      }
    }
    const db = openDb(file);
    db.exec('DELETE FROM accounts WHERE id = 22');
    expect(db.query('SELECT account_id FROM searches').get()).toEqual({ account_id: null });
    expect(db.query('SELECT * FROM conversations').all()).toEqual([]);
    expect(db.query('SELECT * FROM messages').all()).toEqual([]);
    expect(db.query('SELECT * FROM daily_usage').all()).toEqual([]);
    db.close();
  });

  it('rolls the rebuild back when foreign key validation fails, and can reopen after repair', async () => {
    const file = await tempDbFile();
    const old = versionOne(file);
    old.exec("INSERT INTO daily_usage VALUES (999, '2026-10-16', 'dm', 1)");
    const accounts = old.query('SELECT * FROM accounts ORDER BY id').all();
    const related = relatedRows(old);
    old.close();
    expect(() => openDb(file)).toThrow('foreign key validation');
    const unchanged = new Database(file);
    expect(unchanged.query('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(unchanged.query('SELECT * FROM accounts ORDER BY id').all()).toEqual(accounts);
    expect(relatedRows(unchanged)).toEqual(related);
    expect(unchanged.query("SELECT name FROM sqlite_master WHERE name = 'accounts_new'").all()).toEqual([]);
    unchanged.exec('DELETE FROM daily_usage WHERE account_id = 999');
    unchanged.close();
    const repaired = openDb(file);
    expect(repaired.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(repaired.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(repaired.query('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    repaired.close();
  });
});
