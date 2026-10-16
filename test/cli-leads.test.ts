import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { harness } from './support/cli';
import { profile } from './support/fake-x';

async function withAccount() {
  const h = await harness();
  await h.run('init');
  await h.run('account', 'add', '--cookies-file', await h.cookieFile(h.x.signIn('101', 'acme')));
  return h;
}

describe('lead search', () => {
  it('pages through results until --max, keeps only open DMs with --open-dm, and tags them', async () => {
    const h = await withAccount();
    h.x.search = Array.from({ length: 50 }, (_, i) => profile(String(1000 + i), `user${i}`, { canDm: i % 2 === 0 }));
    const result = await h.run('lead', 'search', '--keyword', 'saas founder', '--open-dm', '--max', '15', '--tag', 'founders');
    expect(result.code).toBe(0);
    expect(result.json.data).toMatchObject({ found: 15, added: 15, pages: 2 });

    const listed = await h.run('lead', 'list', '--tag', 'founders', '--limit', '10');
    expect(listed.json.meta).toEqual({ total: 15, returned: 10, next: '10' });
    expect(listed.json.data.every((lead: { dm: string; tags: string[] }) => lead.dm === 'open' && lead.tags.includes('founders'))).toBe(true);
    expect((await h.run('lead', 'list', '--tag', 'founders', '--offset', '10')).json.meta).toEqual({ total: 15, returned: 5 });
  });

  it('does not duplicate a lead found twice', async () => {
    const h = await withAccount();
    h.x.search = [profile('1', 'jane')];
    await h.run('lead', 'search', '--keyword', 'a');
    const second = await h.run('lead', 'search', '--keyword', 'b');
    expect(second.json.data).toMatchObject({ found: 1, added: 0 });
    expect((await h.run('lead', 'list')).json.meta?.total).toBe(1);
  });

  it('needs an account to search', async () => {
    const h = await harness();
    await h.run('init');
    const result = await h.run('lead', 'search', '--keyword', 'x');
    expect(result.code).toBe(3);
    expect(result.json.error?.code).toBe('NO_ACCOUNT');
  });
});

describe('lead import', () => {
  it('imports followers of an account', async () => {
    const h = await withAccount();
    h.x.followers.set('rival', [profile('7', 'fan1'), profile('8', 'fan2', { canDm: false })]);
    const result = await h.run('lead', 'import', '--followers-of', '@rival');
    expect(result.json.data).toMatchObject({ found: 2, added: 2 });
    expect((await h.run('lead', 'list', '--dm', 'closed')).json.data.map((l: { handle: string }) => l.handle)).toEqual(['@fan2']);
  });

  it('imports a CSV of handles and merges a later X match into the same lead', async () => {
    const h = await withAccount();
    const csv = path.join(h.home, 'leads.csv');
    await Bun.write(csv, 'handle,name\n@jane,Jane Doe\nhttps://x.com/bob,\n,\n');
    const imported = await h.run('lead', 'import', '--csv', csv, '--tag', 'event');
    expect(imported.json.data).toMatchObject({ found: 2, added: 2, skippedRows: 0 });

    h.x.search = [profile('55', 'jane', { name: 'Jane' })];
    expect((await h.run('lead', 'search', '--keyword', 'jane')).json.data.added).toBe(0);
    const jane = (await h.run('lead', 'list', '--tag', 'event')).json.data.find((l: { handle: string }) => l.handle === '@jane');
    expect(jane).toMatchObject({ dm: 'open', tags: ['event'] });
  });

  it('refuses both sources at once', async () => {
    const h = await withAccount();
    expect((await h.run('lead', 'import', '--followers-of', '@a', '--csv', 'x.csv')).code).toBe(2);
  });
});

describe('templates', () => {
  it('saves a template and rejects unknown variables', async () => {
    const h = await withAccount();
    expect((await h.run('template', 'add', '--name', 'intro', '--text', 'Hi {{firstName}}!')).code).toBe(0);
    const bad = await h.run('template', 'add', '--name', 'bad', '--text', 'Hi {{company}}');
    expect(bad.code).toBe(2);
    expect((await h.run('template', 'list')).json.data).toEqual([{ name: 'intro', body: 'Hi {{firstName}}!' }]);
  });
});
