/**
 * Browser-impersonating HTTP client for all X.com requests.
 *
 * Wraps `cycletls` (Go-based TLS-impersonation HTTP client). The Node TLS
 * stack used by Node and Bun advertises a JA3/JA4 fingerprint that Cloudflare
 * flags as bot — X serves bot-fingerprinted clients lower 429 thresholds and
 * occasional 403s. By advertising a real Chrome 120 JA3 + HTTP/2 fingerprint,
 * we look indistinguishable from the actual web app at the transport layer.
 *
 * Ported from Scweet's `curl_cffi` usage with `impersonate="chrome120"`.
 *
 * Lifecycle: one CycleTLS process is spawned per process (sidecar Go
 * binary, communicates over an internal port). Call `disposeHttpClient()`
 * on shutdown.
 */
import zlib from 'node:zlib';
import initCycleTLS, { type CycleTLSClient, type CycleTLSResponse } from 'cycletls';
import { resolveTlsHelperPath } from './tls-helper';

// Chrome 120 fingerprints captured from a real session. These match what
// curl_cffi's `impersonate="chrome120"` profile sends.
//
// JA3 string format: SSLVersion,Cipher,SSLExtension,EllipticCurve,EllipticCurvePointFormat
export const CHROME_120_JA3 =
  '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24,0';

// HTTP/2 fingerprint matches Chrome 120 SETTINGS, WINDOW_UPDATE, and pseudo-header order.
export const CHROME_120_HTTP2 = '1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p';

/**
 * Header order Chrome 120 actually emits for authenticated XHR/fetch requests
 * to x.com. Cloudflare's bot heuristics inspect the order — sending the right
 * headers in the wrong order is a fingerprint, especially on sensitive
 * endpoints like `dm/new2.json` and `dm/inbox_initial_state.json`. cycletls
 * sends headers in this order when `orderAsProvided: false` and `headerOrder`
 * is set. Unknown headers (anything we set that isn't in this list) follow
 * after, in insertion order.
 */
const CHROME_120_HEADER_ORDER = [
  'content-length',
  'pragma',
  'cache-control',
  'sec-ch-ua',
  'content-type',
  'sec-ch-ua-mobile',
  'authorization',
  'user-agent',
  'x-csrf-token',
  'x-twitter-auth-type',
  'x-twitter-client-language',
  'x-twitter-active-user',
  'x-client-transaction-id',
  'sec-ch-ua-platform',
  'accept',
  'origin',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'referer',
  'accept-encoding',
  'accept-language',
  'cookie',
  'priority',
];

// User-agent string matches the JA3/HTTP2 profile. Mixing these across versions
// is a strong tell (UA says Chrome 134 but TLS handshake is Chrome 120) — we
// keep them aligned. Individual callers can still pass an override, but they
// SHOULD pick a UA whose major version sits near the impersonate profile.
export const CHROME_120_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let clientPromise: Promise<CycleTLSClient> | null = null;
let clientInstance: CycleTLSClient | null = null;

async function getClient(): Promise<CycleTLSClient> {
  if (clientInstance) return clientInstance;
  if (!clientPromise) {
    clientPromise = resolveTlsHelperPath().then((executablePath) => initCycleTLS({
      executablePath,
      // cycletls's `timeout` is the WebSocket-init deadline in milliseconds.
      // The previous value (60) was a 60ms cap, which races the Go sidecar's
      // own startup on slower hosts (notably macOS dev machines) and rejects
      // with "Failed to initialize CycleTLS" before the binary is ready. 30s
      // matches the per-request timeout default below and gives the sidecar
      // ample room to bind its port and accept the WS handshake.
      timeout: 30_000,
      // autoExit cleans up the sidecar process if the parent exits without
      // calling exit() — important so we never leak a Go process.
      autoExit: true,
    })).then((c) => {
      clientInstance = c;
      return c;
    });
  }
  return clientPromise;
}

export interface ImpersonatedFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'PATCH';
  headers?: Record<string, string>;
  body?: string;
  /** Total request timeout in milliseconds. Default 30s. */
  timeoutMs?: number;
  /** Disable JA3 spoofing (used only for the cycletls health check, not real requests). */
  disableJa3?: boolean;
}

export interface ImpersonatedResponse {
  status: number;
  /** `true` when status is in [200,300). Mirrors `Response.ok`. */
  ok: boolean;
  /** Real `Headers` instance — supports `.get()`, `.getSetCookie()`, etc., like a fetch `Response`. */
  headers: Headers;
  finalUrl: string;
  /** Async to match the fetch Response signature so existing `await response.text()` callers compile. The body is already buffered in memory; awaiting is a formality. */
  text(): Promise<string>;
  json<T = unknown>(): Promise<T | null>;
}

function buildHeaders(raw: CycleTLSResponse['headers']): Headers {
  const out = new Headers();
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    const lower = key.toLowerCase();
    if (Array.isArray(value)) {
      for (const v of value) {
        out.append(lower, String(v));
      }
    } else if (lower === 'set-cookie' && typeof value === 'string' && value.includes('\n')) {
      // cycletls sometimes joins multiple Set-Cookie values with a newline.
      for (const v of value.split(/\r?\n/).filter(Boolean)) {
        out.append(lower, v);
      }
    } else if (value != null) {
      out.append(lower, String(value));
    }
  }
  return out;
}

function toRawBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((data as { data?: unknown }).data)
  ) {
    return Buffer.from((data as { data: number[] }).data);
  }
  return null;
}

/**
 * cycletls's Go sidecar passes the response body through verbatim — it does
 * not decompress when the server returns `Content-Encoding: gzip|deflate|br|zstd`.
 * Since we advertise the full `accept-encoding` set Chrome 120 sends (dropping
 * any one of those would itself be a bot signal), x.com gladly responds with
 * brotli, and the downstream JSON/HTML parsers see garbage. Decompress here so
 * every caller sees a plain UTF-8 body.
 */
function decompressBody(buf: Buffer, encoding: string | undefined): Buffer {
  if (!encoding) return buf;
  const enc = encoding.toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'deflate') {
      // RFC 7230 says deflate is zlib-wrapped, but many servers send raw
      // deflate — try the wrapped form first and fall back to raw.
      try {
        return zlib.inflateSync(buf);
      } catch {
        return zlib.inflateRawSync(buf);
      }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
    if (enc === 'zstd') {
      // Available on Node 22+ but missing from @types/node 20 used by this
      // service. Falls back to returning raw bytes on older runtimes.
      const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer })
        .zstdDecompressSync;
      if (typeof zstd === 'function') return zstd(buf);
    }
  } catch {
    // Fall through to return raw bytes if decompression blows up — caller
    // will see invalid JSON and surface a clearer error than a silent crash.
  }
  return buf;
}

function bodyToText(data: unknown, contentEncoding: string | undefined): string {
  if (typeof data === 'string') return data;
  if (data == null) return '';
  const buf = toRawBuffer(data);
  if (buf) {
    const decoded = decompressBody(buf, contentEncoding);
    return decoded.toString('utf8');
  }
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function extractContentEncoding(raw: CycleTLSResponse['headers']): string | undefined {
  if (!raw) return undefined;
  for (const [key, value] of Object.entries(raw)) {
    if (key.toLowerCase() !== 'content-encoding') continue;
    if (Array.isArray(value)) return value[0]?.toString();
    if (value != null) return String(value);
  }
  return undefined;
}


/**
 * Promote a 2xx response to 429 when X signals the account is out of quota via
 * `x-rate-limit-remaining: 0`. Ported from Scweet's
 * `effective_status_with_rate_limit_headers` (cooldown.py).
 *
 * Why: X sometimes returns a successful (often empty) page along with
 * `x-rate-limit-remaining: 0` and an `x-rate-limit-reset` epoch. If we treat
 * that as a normal success we'll spin on the same account, hammering it until
 * X starts returning real 429s — by which point the account's cooldown is
 * longer than it would have been if we'd backed off immediately. Promoting the
 * status surfaces the cooldown to the existing 429 path (which honors
 * `x-rate-limit-reset`) so the rate-limit tracker cools the account once.
 */
function promoteSoftRateLimit(status: number, headers: Headers): number {
  if (status < 200 || status >= 300) return status;
  const remainingHeader = headers.get('x-rate-limit-remaining');
  if (remainingHeader === null) return status;
  const remaining = parseInt(remainingHeader, 10);
  if (Number.isFinite(remaining) && remaining <= 0) {
    return 429;
  }
  return status;
}

/**
 * Performs a single HTTP request with Chrome 120 TLS + HTTP/2 fingerprint.
 *
 * Errors thrown: `Error` for transport-level failures (DNS, connect refused,
 * timeout). Non-2xx responses do NOT throw — caller inspects `status`.
 */
export async function fetchImpersonated(
  url: string,
  options: ImpersonatedFetchOptions = {},
): Promise<ImpersonatedResponse> {
  const client = await getClient();
  const method = (options.method ?? 'GET').toLowerCase() as
    | 'get'
    | 'post'
    | 'put'
    | 'delete'
    | 'head'
    | 'patch';
  const timeoutSec = Math.max(1, Math.ceil((options.timeoutMs ?? 30_000) / 1000));

  const requestOptions: Parameters<typeof client>[1] = {
    headers: options.headers ?? {},
    timeout: timeoutSec,
    userAgent: options.headers?.['user-agent'] ?? CHROME_120_USER_AGENT,
    headerOrder: CHROME_120_HEADER_ORDER,
    ...(options.disableJa3 ? {} : { ja3: CHROME_120_JA3, http2Fingerprint: CHROME_120_HTTP2 }),
    ...(options.body !== undefined ? { body: options.body } : {}),
  };

  const raw = await client(url, requestOptions, method);
  const contentEncoding = extractContentEncoding(raw.headers);
  const headers = buildHeaders(raw.headers);
  // After decompression the Content-Encoding header is no longer correct —
  // strip it so downstream consumers (e.g. set-cookie rotation) don't trip
  // over a length/encoding mismatch.
  if (contentEncoding) headers.delete('content-encoding');
  const bodyText = bodyToText(raw.data, contentEncoding);
  const effectiveStatus = promoteSoftRateLimit(raw.status, headers);

  return {
    status: effectiveStatus,
    ok: effectiveStatus >= 200 && effectiveStatus < 300,
    headers,
    finalUrl: raw.finalUrl,
    text: async () => bodyText,
    json: async <T = unknown>() => {
      try {
        return JSON.parse(bodyText) as T;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Cleanly shuts down the cycletls sidecar. Call on process exit.
 */
export async function disposeHttpClient(): Promise<void> {
  if (!clientInstance) return;
  try {
    await clientInstance.exit();
  } catch {
    // ignore — sidecar may already be gone
  }
  clientInstance = null;
  clientPromise = null;
}
