import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations';

export type Db = Database;

// The database holds DM text, so the folder, the file and SQLite's side files
// are created owner-only.
export function openDb(file: string): Db {
  const previous = process.umask(0o077);
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const db = new Database(file, { create: true, strict: true });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      migrate(db);
    } catch (error) {
      db.close();
      throw error;
    }
    return db;
  } finally {
    process.umask(previous);
  }
}

function migrate(db: Db): void {
  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
  const applied = row?.user_version ?? 0;
  if (applied >= MIGRATIONS.length) return;
  // Rebuilding a referenced table requires disabling foreign keys before BEGIN,
  // not inside the transaction. Validate all relationships before each commit.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (let index = applied; index < MIGRATIONS.length; index++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[index] as string);
        if (db.query('PRAGMA foreign_key_check').all().length > 0) {
          throw new Error('Database migration failed foreign key validation.');
        }
        db.exec(`PRAGMA user_version = ${index + 1}`);
      })();
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
