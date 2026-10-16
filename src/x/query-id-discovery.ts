/**
 * Manifest discovery for X.com GraphQL operations.
 *
 * Pulls query IDs *and* feature-switch flags from x.com's `main.<hash>.js`
 * bundle. The bundle is the same source of truth the real web app reads at
 * boot, so any flag X flips lands here immediately — that's the whole point
 * of doing this dynamically instead of shipping hardcoded constants that rot.
 *
 * Port of Scweet's `manifest.py`. The Playwright-driven discovery path was
 * removed: spawning headless Chromium to hit x.com triggers Cloudflare more
 * often than not and is the slow path (5–10s). Plain HTTP via the
 * impersonating client is ~10x faster and clears Cloudflare reliably because
 * we look like a real Chrome 120 client at the TLS layer.
 */
import { fetchImpersonated } from './http-client';
import { log } from './log';

const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_BUNDLE_BYTES = 600 * 1024;
const BATCH_SIZE = 5;
const FETCH_TIMEOUT_MS = 20_000;

/** Operation names exactly as they appear in the X.com bundle. */
const OPERATION_NAMES = [
  'SearchTimeline',
  'Followers',
  'BlueVerifiedFollowers',
  'Following',
  'UserByScreenName',
  'UserByRestId',
  'membersSliceTimeline_Query',
  'TweetDetail',
] as const;
export type OperationName = (typeof OPERATION_NAMES)[number];

export interface ManifestEntry {
  queryId: string;
  /** Feature-switch flag names extracted from the bundle near this operation. Unknown switches default false, matching Scweet's live-manifest fallback. */
  features: string[];
}

export type Manifest = Partial<Record<OperationName, ManifestEntry>>;

interface CacheState {
  manifest: Manifest;
  discoveredAt: number;
}

let _cache: CacheState | null = null;
let _inflight: Promise<Manifest> | null = null;

function isFresh(): boolean {
  return _cache !== null && Date.now() - _cache.discoveredAt < CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// Bundle extraction
// ---------------------------------------------------------------------------

function extractQueryId(bundle: string, op: OperationName): string | null {
  // Pattern: {queryId:"abc123",operationName:"Followers"
  const re = new RegExp(`queryId:"([A-Za-z0-9_-]{8,40})",operationName:"${op}"`);
  const m = bundle.match(re);
  return m ? m[1] : null;
}

/**
 * Extracts the feature-switch flag names attached to a given operation. X
 * emits these inline as a `featureSwitches:["a","b",...]` array near the
 * operation's metadata block. We grep for the first one within ±3000 chars
 * of the operation reference — Scweet's heuristic, works reliably.
 */
function extractOperationFeatures(bundle: string, op: OperationName): string[] {
  const idx = bundle.indexOf(`operationName:"${op}"`);
  if (idx === -1) return [];

  const start = Math.max(0, idx - 3000);
  const end = Math.min(bundle.length, idx + 3000);
  const window = bundle.slice(start, end);

  const m = window.match(/featureSwitches:\[([^\]]+)\]/);
  if (!m) return [];

  const out: string[] = [];
  for (const nm of m[1].matchAll(/"([A-Za-z0-9_]+)"/g)) {
    out.push(nm[1]);
  }
  return out;
}

function mergeIntoManifest(bundle: string, into: Manifest): void {
  for (const op of OPERATION_NAMES) {
    if (into[op]) continue;
    const queryId = extractQueryId(bundle, op);
    if (!queryId) continue;
    into[op] = {
      queryId,
      features: extractOperationFeatures(bundle, op),
    };
  }
}

function isComplete(m: Manifest): boolean {
  return OPERATION_NAMES.every((op) => m[op] !== undefined);
}

// ---------------------------------------------------------------------------
// HTTP fetch
// ---------------------------------------------------------------------------

async function fetchText(url: string, extraHeaders: Record<string, string> = {}): Promise<string> {
  const res = await fetchImpersonated(url, {
    method: 'GET',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/javascript,*/*',
      'accept-language': 'en-US,en;q=0.9',
      ...extraHeaders,
    },
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.text();
}

function extractBundleUrls(html: string): string[] {
  const re = /(?:src|href)="(https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"]+\.js(?:\?[^"]*)?)"/g;
  return [...new Set(Array.from(html.matchAll(re), (m) => m[1]))];
}

async function fetchBundle(url: string): Promise<string | null> {
  try {
    return await fetchText(url, { Range: `bytes=0-${MAX_BUNDLE_BYTES - 1}` });
  } catch {
    return null;
  }
}

// X's logged-out homepage moved to a new `x-web` bundle that no longer names
// GraphQL operations, while `/i/jf/` still serves the `responsive-web` bundle.
const BUNDLE_PAGES = ['https://x.com/', 'https://x.com/i/jf/'];

async function findBundleUrls(): Promise<string[]> {
  for (const page of BUNDLE_PAGES) {
    try {
      const urls = extractBundleUrls(await fetchText(page));
      log.info(`[ManifestDiscovery] Found ${urls.length} bundle(s) on ${page}`);
      if (urls.length > 0) return urls;
    } catch (err) {
      log.warn(`[ManifestDiscovery] Failed to fetch ${page}:`, (err as Error)?.message);
    }
  }
  return [];
}

async function runDiscovery(): Promise<Manifest> {
  const manifest: Manifest = {};
  const bundleUrls = await findBundleUrls();

  for (let i = 0; i < bundleUrls.length; i += BATCH_SIZE) {
    if (isComplete(manifest)) break;
    const batch = bundleUrls.slice(i, i + BATCH_SIZE);
    const bodies = await Promise.all(batch.map((u) => fetchBundle(u)));
    for (const body of bodies) {
      if (body) mergeIntoManifest(body, manifest);
      if (isComplete(manifest)) break;
    }
  }

  for (const op of OPERATION_NAMES) {
    const entry = manifest[op];
    if (entry) {
      log.info(
        `[ManifestDiscovery] ${op}: queryId=${entry.queryId} features=${entry.features.length}`,
      );
    } else {
      log.warn(`[ManifestDiscovery] Did not find queryId for ${op}`);
    }
  }

  return manifest;
}

async function getManifest(): Promise<Manifest> {
  if (isFresh()) return _cache!.manifest;
  if (_inflight) return _inflight;
  _inflight = runDiscovery()
    .then((manifest) => {
      _cache = { manifest, discoveredAt: Date.now() };
      return manifest;
    })
    .finally(() => {
      _inflight = null;
    });
  return _inflight;
}

// ---------------------------------------------------------------------------
// Public API — generic
// ---------------------------------------------------------------------------

export async function discoverManifest(): Promise<Manifest> {
  return getManifest();
}

export async function getQueryId(op: OperationName): Promise<string | null> {
  const manifest = await getManifest();
  return manifest[op]?.queryId ?? null;
}

/**
 * Returns discovered feature switches as `Record<flag, false>`. Callers should
 * merge this with bundled operation defaults instead of replacing known-good
 * manifests with an all-true payload.
 */
export async function getFeatureFlags(op: OperationName): Promise<Record<string, false>> {
  const manifest = await getManifest();
  const features = manifest[op]?.features ?? [];
  const out: Record<string, false> = {};
  for (const name of features) {
    out[name] = false;
  }
  return out;
}

export function invalidateManifestCache(): void {
  _cache = null;
}

// ---------------------------------------------------------------------------
// Backward-compatible exports for existing callers in client.ts
// ---------------------------------------------------------------------------

/** @deprecated Use `getQueryId('SearchTimeline')` directly. */
export async function discoverSearchTimelineQueryId(): Promise<string | null> {
  return getQueryId('SearchTimeline');
}

/** @deprecated Use `getQueryId('Followers'/'BlueVerifiedFollowers')` directly. */
export async function discoverFollowerQueryIds(): Promise<{
  followers: string | null;
  following: string | null;
  blueVerifiedFollowers: string | null;
}> {
  const manifest = await getManifest();
  return {
    followers: manifest.Followers?.queryId ?? null,
    following: manifest.Following?.queryId ?? null,
    blueVerifiedFollowers: manifest.BlueVerifiedFollowers?.queryId ?? null,
  };
}

export function invalidateQueryIdCache(): void {
  invalidateManifestCache();
}

export function invalidateFollowerQueryIdCache(): void {
  invalidateManifestCache();
}
