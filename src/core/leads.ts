import type { XPage, XProfile } from '../x/session';
import { type Account, bareHandle, withX } from './accounts';
import type { App } from './app';
import type { CsvLead } from './csv';
import { ReachloopError } from './errors';

export type LeadStatus = 'new' | 'contacted' | 'replied' | 'opted_out';
export type DmEligibility = 'open' | 'closed' | 'unknown';
export type LeadSource = 'keyword' | 'followers' | 'csv' | 'inbox';

export type Lead = {
  id: number;
  xUserId: string | null;
  handle: string;
  name: string | null;
  bio: string | null;
  followers: number | null;
  status: LeadStatus;
  dm: DmEligibility;
  source: LeadSource;
  tags: string[];
};

type LeadRow = {
  id: number;
  x_user_id: string | null;
  handle: string;
  name: string | null;
  bio: string | null;
  followers: number | null;
  status: LeadStatus;
  dm_eligibility: DmEligibility;
  source: LeadSource;
  tags: string | null;
};

const LEAD_SELECT = `
  SELECT l.id, l.x_user_id, l.handle, l.name, l.bio, l.followers, l.status, l.dm_eligibility, l.source,
         (SELECT group_concat(tag, ',') FROM lead_tags t WHERE t.lead_id = l.id) AS tags
  FROM leads l`;

function toLead(row: LeadRow): Lead {
  return {
    id: row.id,
    xUserId: row.x_user_id,
    handle: row.handle,
    name: row.name,
    bio: row.bio,
    followers: row.followers,
    status: row.status,
    dm: row.dm_eligibility,
    source: row.source,
    tags: row.tags ? row.tags.split(',').sort() : [],
  };
}

type LeadInput = { xUserId?: string; handle: string; name?: string; bio?: string; followers?: number; following?: number; verified?: boolean; canDm?: boolean };

function eligibility(canDm: boolean | undefined): DmEligibility {
  if (canDm === true) return 'open';
  if (canDm === false) return 'closed';
  return 'unknown';
}

// Matches by X user id first, then by handle for rows that never had an id
// (CSV imports). Known facts are never overwritten with unknowns.
export function upsertLead(app: App, input: LeadInput, source: LeadSource, tags: string[] = []): { id: number; added: boolean } {
  const byId = input.xUserId
    ? app.db.query<{ id: number }, [string]>('SELECT id FROM leads WHERE x_user_id = ?').get(input.xUserId)
    : null;
  const existing =
    byId ??
    app.db
      .query<{ id: number }, [string]>('SELECT id FROM leads WHERE handle = ? AND x_user_id IS NULL')
      .get(bareHandle(input.handle));
  const dm = eligibility(input.canDm);
  let id: number;
  if (existing) {
    id = existing.id;
    app.db
      .query(
        `UPDATE leads SET
           x_user_id = COALESCE(?, x_user_id), handle = ?, name = COALESCE(?, name), bio = COALESCE(?, bio),
           followers = COALESCE(?, followers), following = COALESCE(?, following),
           verified = MAX(verified, ?), dm_eligibility = CASE WHEN ? = 'unknown' THEN dm_eligibility ELSE ? END
         WHERE id = ?`,
      )
      .run(
        input.xUserId ?? null,
        bareHandle(input.handle),
        input.name ?? null,
        input.bio ?? null,
        input.followers ?? null,
        input.following ?? null,
        input.verified ? 1 : 0,
        dm,
        dm,
        id,
      );
  } else {
    const result = app.db
      .query(
        `INSERT INTO leads (x_user_id, handle, name, bio, followers, following, verified, dm_eligibility, source, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.xUserId ?? null,
        bareHandle(input.handle),
        input.name ?? null,
        input.bio ?? null,
        input.followers ?? null,
        input.following ?? null,
        input.verified ? 1 : 0,
        dm,
        source,
        app.now(),
      );
    id = Number(result.lastInsertRowid);
  }
  for (const tag of tags) app.db.query('INSERT OR IGNORE INTO lead_tags (lead_id, tag) VALUES (?, ?)').run(id, tag);
  return { id, added: !existing };
}

function profileInput(profile: XProfile): LeadInput {
  return {
    xUserId: profile.xUserId,
    handle: profile.handle,
    name: profile.name,
    bio: profile.bio,
    followers: profile.followers,
    following: profile.following,
    verified: profile.verified,
    canDm: profile.canDm,
  };
}

export type CollectResult = { searchId: number; found: number; added: number; skippedClosed: number; pages: number };

const MAX_PAGES = 50;

async function collect(
  app: App,
  args: {
    account: Account;
    kind: 'keyword' | 'followers';
    query: string;
    max: number;
    openDmOnly: boolean;
    tags: string[];
    page: (cursor: string | undefined) => Promise<XPage>;
  },
): Promise<CollectResult> {
  let cursor: string | undefined;
  let found = 0;
  let added = 0;
  let skippedClosed = 0;
  let pages = 0;
  const seen = new Set<string>();
  while (found < args.max && pages < MAX_PAGES) {
    const page = await args.page(cursor);
    pages++;
    for (const profile of page.profiles) {
      if (found >= args.max) break;
      if (seen.has(profile.xUserId)) continue;
      seen.add(profile.xUserId);
      if (args.openDmOnly && profile.canDm !== true) {
        skippedClosed++;
        continue;
      }
      found++;
      if (upsertLead(app, profileInput(profile), args.kind, args.tags).added) added++;
    }
    if (!page.nextCursor || page.profiles.length === 0) break;
    cursor = page.nextCursor;
  }
  const search = app.db
    .query('INSERT INTO searches (kind, query, account_id, max, found, added, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(args.kind, args.query, args.account.id, args.max, found, added, app.now());
  return { searchId: Number(search.lastInsertRowid), found, added, skippedClosed, pages };
}

export function searchLeads(
  app: App,
  args: { account: Account; keyword: string; max: number; openDmOnly: boolean; tags: string[] },
): Promise<CollectResult> {
  return withX(app, args.account, (x) =>
    collect(app, {
      ...args,
      kind: 'keyword',
      query: args.keyword,
      page: (cursor) => x.searchUsers({ query: args.keyword, cursor }),
    }),
  );
}

export function importFollowers(
  app: App,
  args: { account: Account; handle: string; max: number; openDmOnly: boolean; tags: string[] },
): Promise<CollectResult> {
  const handle = bareHandle(args.handle);
  return withX(app, args.account, (x) =>
    collect(app, { ...args, kind: 'followers', query: handle, page: (cursor) => x.followersOf({ handle, cursor }) }),
  );
}

export function importCsv(app: App, args: { rows: CsvLead[]; tags: string[] }): { found: number; added: number } {
  let added = 0;
  app.db.transaction(() => {
    for (const row of args.rows) {
      if (upsertLead(app, row, 'csv', args.tags).added) added++;
    }
    app.db
      .query("INSERT INTO searches (kind, query, max, found, added, created_at) VALUES ('csv', 'csv', NULL, ?, ?, ?)")
      .run(args.rows.length, added, app.now());
  })();
  return { found: args.rows.length, added };
}

export function listLeads(
  app: App,
  args: { status?: LeadStatus; tag?: string; dm?: DmEligibility; limit: number; offset: number },
): { leads: Lead[]; total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (args.status) {
    where.push('l.status = ?');
    params.push(args.status);
  }
  if (args.dm) {
    where.push('l.dm_eligibility = ?');
    params.push(args.dm);
  }
  if (args.tag) {
    where.push('EXISTS (SELECT 1 FROM lead_tags t WHERE t.lead_id = l.id AND t.tag = ?)');
    params.push(args.tag);
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total =
    app.db.query<{ n: number }, (string | number)[]>(`SELECT count(*) AS n FROM leads l${clause}`).get(...params)?.n ?? 0;
  const leads = app.db
    .query<LeadRow, (string | number)[]>(`${LEAD_SELECT}${clause} ORDER BY l.id DESC LIMIT ? OFFSET ?`)
    .all(...params, args.limit, args.offset)
    .map(toLead);
  return { leads, total };
}

export function findLead(app: App, handle: string): Lead {
  const row = app.db
    .query<LeadRow, [string]>(`${LEAD_SELECT} WHERE l.handle = ? ORDER BY l.x_user_id IS NULL LIMIT 1`)
    .get(bareHandle(handle));
  if (!row) throw new ReachloopError('NOT_FOUND', `No lead @${bareHandle(handle)}.`, { hint: 'reachloop inbox sync' });
  return toLead(row);
}
