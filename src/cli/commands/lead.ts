import { readFile } from 'node:fs/promises';
import { resolveAccount } from '../../core/accounts';
import { parseLeadCsv } from '../../core/csv';
import { ReachloopError } from '../../core/errors';
import { importCsv, importFollowers, type Lead, listLeads, searchLeads } from '../../core/leads';
import { bool, type Command, int, oneOf, requiredStr, str, tags } from '../command';

const MAX_LEADS_PER_RUN = 1000;

function leadView(lead: Lead) {
  return {
    handle: `@${lead.handle}`,
    name: lead.name,
    dm: lead.dm,
    status: lead.status,
    followers: lead.followers,
    tags: lead.tags,
  };
}

export const leadCommands: Command[] = [
  {
    path: 'lead search',
    usage: 'reachloop lead search --keyword "<words>" [--open-dm] [--max 200] [--tag t] [--account @a]',
    summary: 'Find people on X whose profile matches the words, and save them as leads.',
    db: 'required',
    options: { keyword: { type: 'string' }, 'open-dm': { type: 'boolean' }, max: { type: 'string' }, tag: { type: 'string' }, account: { type: 'string' } },
    run: async ({ app, values }) => {
      const account = resolveAccount(app, str(values, 'account'));
      const result = await searchLeads(app, {
        account,
        keyword: requiredStr(values, 'keyword'),
        max: int(values, 'max', 100, { min: 1, max: MAX_LEADS_PER_RUN }),
        openDmOnly: bool(values, 'open-dm'),
        tags: tags(values),
      });
      return { data: result, hints: ['reachloop lead list --limit 20 --json'] };
    },
  },
  {
    path: 'lead import',
    usage: 'reachloop lead import --followers-of @handle [--max 500] [--open-dm] [--tag t]  |  --csv <file> [--tag t]',
    summary: "Save leads from someone's followers, or from a CSV file with a handle column.",
    db: 'required',
    options: {
      'followers-of': { type: 'string' },
      csv: { type: 'string' },
      max: { type: 'string' },
      'open-dm': { type: 'boolean' },
      tag: { type: 'string' },
      account: { type: 'string' },
    },
    run: async ({ app, values }) => {
      const followersOf = str(values, 'followers-of');
      const csv = str(values, 'csv');
      if ((followersOf ? 1 : 0) + (csv ? 1 : 0) !== 1) {
        throw new ReachloopError('USAGE', 'Use exactly one of --followers-of or --csv.');
      }
      if (followersOf) {
        const result = await importFollowers(app, {
          account: resolveAccount(app, str(values, 'account')),
          handle: followersOf,
          max: int(values, 'max', 200, { min: 1, max: MAX_LEADS_PER_RUN }),
          openDmOnly: bool(values, 'open-dm'),
          tags: tags(values),
        });
        return { data: result, hints: ['reachloop lead list --limit 20 --json'] };
      }
      const text = await readFile(csv ?? '', 'utf8').catch(() => {
        throw new ReachloopError('NOT_FOUND', `Cannot read ${csv}.`);
      });
      const parsed = parseLeadCsv(text);
      if (!parsed.ok) {
        throw new ReachloopError('USAGE', `The CSV has ${parsed.reason}.`, { hint: 'Add a header row with a "handle" column.' });
      }
      const result = importCsv(app, { rows: parsed.rows, tags: tags(values) });
      return { data: { ...result, skippedRows: parsed.skipped }, hints: ['reachloop lead list --limit 20 --json'] };
    },
  },
  {
    path: 'lead list',
    usage: 'reachloop lead list [--status new|contacted|replied|opted_out] [--dm open|closed|unknown] [--tag t] [--limit 20] [--offset 0]',
    summary: 'List saved leads, newest first.',
    db: 'required',
    options: { status: { type: 'string' }, dm: { type: 'string' }, tag: { type: 'string' }, limit: { type: 'string' }, offset: { type: 'string' } },
    run: async ({ app, values }) => {
      const limit = int(values, 'limit', 20, { min: 1, max: 500 });
      const offset = int(values, 'offset', 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
      const { leads, total } = listLeads(app, {
        status: oneOf(values, 'status', ['new', 'contacted', 'replied', 'opted_out'] as const),
        dm: oneOf(values, 'dm', ['open', 'closed', 'unknown'] as const),
        tag: str(values, 'tag'),
        limit,
        offset,
      });
      const next = offset + leads.length < total ? String(offset + leads.length) : undefined;
      return {
        data: leads.map(leadView),
        meta: { total, returned: leads.length, ...(next ? { next } : {}) },
        hints: next ? [`reachloop lead list --offset ${next} --json`] : [],
      };
    },
  },
];
