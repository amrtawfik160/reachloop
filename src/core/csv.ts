export type CsvLead = { handle: string; xUserId?: string; name?: string; bio?: string };

export type CsvResult = { ok: true; rows: CsvLead[]; skipped: number } | { ok: false; reason: string };

function records(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out.filter((r) => r.some((value) => value.trim().length > 0));
}

const COLUMNS = {
  handle: ['handle', 'username', 'screen_name', 'screenname', 'twitter', 'x'],
  xUserId: ['x_user_id', 'user_id', 'id'],
  name: ['name', 'display_name'],
  bio: ['bio', 'description'],
} as const;

function cleanHandle(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '');
}

export function parseLeadCsv(text: string): CsvResult {
  const [header, ...body] = records(text.replace(/^﻿/, ''));
  if (!header) return { ok: false, reason: 'empty file' };
  const names = header.map((name) => name.trim().toLowerCase());
  const indexOf = (aliases: readonly string[]) => names.findIndex((name) => aliases.includes(name));
  const handleAt = indexOf(COLUMNS.handle);
  if (handleAt === -1) return { ok: false, reason: 'no handle column' };
  const idAt = indexOf(COLUMNS.xUserId);
  const nameAt = indexOf(COLUMNS.name);
  const bioAt = indexOf(COLUMNS.bio);
  const rows: CsvLead[] = [];
  let skipped = 0;
  for (const record of body) {
    const handle = cleanHandle(record[handleAt] ?? '');
    if (!handle) {
      skipped++;
      continue;
    }
    const optional = (at: number) => {
      const value = at === -1 ? '' : (record[at] ?? '').trim();
      return value.length > 0 ? value : undefined;
    };
    const xUserId = optional(idAt);
    const name = optional(nameAt);
    const bio = optional(bioAt);
    rows.push({ handle, ...(name ? { name } : {}), ...(xUserId ? { xUserId } : {}), ...(bio ? { bio } : {}) });
  }
  return { ok: true, rows, skipped };
}
