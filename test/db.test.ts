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
