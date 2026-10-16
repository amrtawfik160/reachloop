import { describe, expect, it } from 'bun:test';
import { parseLeadCsv } from '../src/core/csv';

describe('parseLeadCsv', () => {
  it('reads handles and optional columns by header name', () => {
    const csv = 'Handle,Name,x_user_id\n@jane,"Jane, Doe",123\nbob,Bob,\n';
    expect(parseLeadCsv(csv)).toEqual({
      ok: true,
      rows: [
        { handle: 'jane', name: 'Jane, Doe', xUserId: '123' },
        { handle: 'bob', name: 'Bob' },
      ],
      skipped: 0,
    });
  });

  it('accepts username or screen_name as the handle column and skips rows without one', () => {
    const csv = 'screen_name,bio\r\nann,"says ""hi"""\r\n,empty\r\n';
    expect(parseLeadCsv(csv)).toEqual({ ok: true, rows: [{ handle: 'ann', bio: 'says "hi"' }], skipped: 1 });
  });

  it('reads an x.com profile URL as a handle', () => {
    expect(parseLeadCsv('handle\nhttps://x.com/Carol\n')).toEqual({ ok: true, rows: [{ handle: 'Carol' }], skipped: 0 });
  });

  it('fails when no column names a handle', () => {
    expect(parseLeadCsv('email\na@b.c\n')).toEqual({ ok: false, reason: 'no handle column' });
  });
});
