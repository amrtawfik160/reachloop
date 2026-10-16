import { disposeHttpClient, fetchImpersonated, CHROME_120_JA3 } from '../src/x/http-client';
import { discoverManifest } from '../src/x/query-id-discovery';
import { lookupUserByRestId, parseUserIdFromTwid, TwitterGraphQLClient, type TwitterAuthCookies } from '../src/x/client';
import { parseCookieFile } from '../src/x/cookies';

type PeetResponse = {
  http_version?: string;
  user_agent?: string;
  tls?: { ja3?: string; ja3_hash?: string };
  http2?: { akamai_fingerprint?: string };
};

async function tls(): Promise<Record<string, unknown>> {
  const res = await fetchImpersonated('https://tls.peet.ws/api/all');
  const body = await res.json<PeetResponse>();
  const ja3 = body?.tls?.ja3 ?? '';
  const sentCiphers = CHROME_120_JA3.split(',')[1];
  return {
    status: res.status,
    httpVersion: body?.http_version,
    ja3Hash: body?.tls?.ja3_hash,
    ciphersMatchChrome120: ja3.split(',')[1] === sentCiphers,
    http2Fingerprint: body?.http2?.akamai_fingerprint,
    userAgent: body?.user_agent,
  };
}

async function manifest(): Promise<Record<string, unknown>> {
  const found = await discoverManifest();
  return { operations: Object.fromEntries(Object.entries(found).map(([op, entry]) => [op, entry?.queryId])) };
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function signedIn(): Promise<TwitterAuthCookies> {
  const file = flag('cookies-file');
  if (!file) throw new Error('--cookies-file <path> is required for this check');
  const parsed = parseCookieFile(await Bun.file(file).text());
  if (!parsed.ok) throw new Error(`cookie file is missing: ${parsed.missing.join(', ')}`);
  return parsed.cookies;
}

async function account(): Promise<Record<string, unknown>> {
  const auth = await signedIn();
  const userId = parseUserIdFromTwid(auth.twid);
  if (!userId) throw new Error('cookie file has no twid cookie');
  const user = await lookupUserByRestId({ auth, userId });
  return { userId: user.userId, handle: user.screenName, followers: user.followerCount };
}

async function search(): Promise<Record<string, unknown>> {
  const client = new TwitterGraphQLClient(await signedIn());
  const page = await client.searchUsers({ query: flag('keyword') ?? 'saas founder', count: 20 });
  return {
    users: page.users.length,
    dmOpen: page.users.filter((user) => user.canDm).length,
    firstHandles: page.users.slice(0, 3).map((user) => user.username),
    hasNextPage: page.hasNextPage,
  };
}

async function inbox(): Promise<Record<string, unknown>> {
  const client = new TwitterGraphQLClient(await signedIn());
  const trusted = await client.getInboxConversations({ count: 20 });
  const requests = await client.getInboxConversations({ count: 20, kind: 'untrusted' });
  return {
    conversations: trusted.conversations.length,
    unread: trusted.conversations.filter((c) => c.isUnread).length,
    messageRequests: requests.conversations.length,
  };
}

const checks: Record<string, () => Promise<Record<string, unknown>>> = { tls, manifest, account, search, inbox };
const name = process.argv[2] ?? 'tls';
const check = checks[name];
if (!check) {
  process.stderr.write(`unknown check ${name}; use one of: ${Object.keys(checks).join(', ')}\n`);
  process.exit(2);
}
try {
  process.stdout.write(`${JSON.stringify({ ok: true, check: name, data: await check() })}\n`);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ok: false, check: name, error: String((err as Error)?.message ?? err) })}\n`);
  process.exitCode = 1;
} finally {
  await disposeHttpClient();
}
