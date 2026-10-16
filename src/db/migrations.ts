// Append-only. Each entry runs once, in order, and PRAGMA user_version records
// how many have run.
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    x_user_id TEXT NOT NULL UNIQUE,
    handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
    status TEXT NOT NULL CHECK (status IN ('active','paused','session_expired','suspended')),
    sign_in TEXT NOT NULL CHECK (sign_in IN ('cookies','browser')),
    secret_ref TEXT NOT NULL,
    cap_dm INTEGER NOT NULL DEFAULT 50 CHECK (cap_dm BETWEEN 0 AND 200),
    last_inbox_sync_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE leads (
    id INTEGER PRIMARY KEY,
    x_user_id TEXT UNIQUE,
    handle TEXT NOT NULL COLLATE NOCASE,
    name TEXT,
    bio TEXT,
    followers INTEGER,
    following INTEGER,
    verified INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','replied','opted_out')),
    dm_eligibility TEXT NOT NULL DEFAULT 'unknown' CHECK (dm_eligibility IN ('open','closed','unknown')),
    source TEXT NOT NULL,
    added_at INTEGER NOT NULL
  );
  CREATE INDEX leads_handle ON leads (handle);
  CREATE INDEX leads_status ON leads (status, added_at);

  CREATE TABLE lead_tags (
    lead_id INTEGER NOT NULL REFERENCES leads ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (lead_id, tag)
  );

  CREATE TABLE searches (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('keyword','followers','csv')),
    query TEXT NOT NULL,
    account_id INTEGER REFERENCES accounts ON DELETE SET NULL,
    max INTEGER,
    found INTEGER NOT NULL DEFAULT 0,
    added INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE templates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts ON DELETE CASCADE,
    lead_id INTEGER NOT NULL REFERENCES leads ON DELETE CASCADE,
    x_conversation_id TEXT NOT NULL,
    has_inbound INTEGER NOT NULL DEFAULT 0,
    unread INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER,
    UNIQUE (account_id, lead_id)
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    body TEXT NOT NULL,
    x_message_id TEXT UNIQUE,
    dedupe_key TEXT UNIQUE,
    send_state TEXT CHECK (send_state IN ('reserved','sent','failed')),
    origin TEXT NOT NULL CHECK (origin IN ('x','reply')),
    at INTEGER NOT NULL
  );
  CREATE INDEX messages_conversation ON messages (conversation_id, at);

  CREATE TABLE daily_usage (
    account_id INTEGER NOT NULL REFERENCES accounts ON DELETE CASCADE,
    day TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('dm')),
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, day, action)
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    account_id INTEGER,
    lead_id INTEGER,
    data_json TEXT
  );
  CREATE INDEX events_at ON events (at);

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `
  CREATE TABLE accounts_new (
    id INTEGER PRIMARY KEY,
    x_user_id TEXT NOT NULL UNIQUE,
    handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
    status TEXT NOT NULL CHECK (status IN ('active','paused','session_expired','suspended')),
    sign_in TEXT NOT NULL CHECK (sign_in IN ('cookies','browser')),
    secret_ref TEXT NOT NULL,
    cap_dm INTEGER NOT NULL DEFAULT 50 CHECK (cap_dm BETWEEN 0 AND 250),
    last_inbox_sync_at INTEGER,
    created_at INTEGER NOT NULL,
    reply_only INTEGER NOT NULL DEFAULT 0 CHECK (reply_only IN (0, 1))
  );
  INSERT INTO accounts_new (
    id, x_user_id, handle, status, sign_in, secret_ref, cap_dm, last_inbox_sync_at, created_at
  ) SELECT id, x_user_id, handle, status, sign_in, secret_ref, cap_dm, last_inbox_sync_at, created_at FROM accounts;
  DROP TABLE accounts;
  ALTER TABLE accounts_new RENAME TO accounts;
  `,
];
