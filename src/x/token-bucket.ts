/**
 * Proactive rate limiter for X.com GraphQL operations.
 *
 * Ported from Scweet's `limiter.py` (TokenBucketLimiter). We pace requests
 * BEFORE they leave the process so we stop bursting into X's per-account 429
 * walls. The reactive tracker in `app/api/twitter/_rate-limit-tracker.ts` stays
 * as a backstop for when X tightens its limits unexpectedly.
 *
 * Two constraints are enforced per `(accountId, operation)` key:
 *   1. Token bucket: capacity = `capacityPerMin`, refill = capacity / 60s.
 *   2. Minimum spacing: `minDelayMs` between consecutive acquires.
 *
 * If a 429 still slips through, `throttle()` halves a bucket's capacity for
 * a configurable window so we back off automatically until X cools down.
 */
export class TokenBucket {
  private tokens: number;
  private originalCapacity: number;
  private capacity: number;
  private refillRatePerMs: number;
  private lastRefillAt: number;
  private lastAcquireAt = 0;
  private pendingChain: Promise<void> = Promise.resolve();
  private throttleResetAt = 0;

  constructor(
    capacityPerMin: number,
    private readonly minDelayMs: number,
  ) {
    this.originalCapacity = capacityPerMin;
    this.capacity = capacityPerMin;
    this.tokens = capacityPerMin;
    this.refillRatePerMs = capacityPerMin / 60_000;
    this.lastRefillAt = Date.now();
  }

  /**
   * Serialized acquire: caller is paused until a token is available AND the
   * minimum delay since the last acquire has elapsed.
   */
  async acquire(): Promise<void> {
    const next = this.pendingChain.then(() => this.acquireImpl());
    this.pendingChain = next.catch(() => {});
    return next;
  }

  private async acquireImpl(): Promise<void> {
    this.maybeRestoreCapacity();

    while (true) {
      this.refill();

      const sinceLast = Date.now() - this.lastAcquireAt;
      const delayWait = Math.max(0, this.minDelayMs - sinceLast);

      let tokenWait = 0;
      if (this.tokens < 1) {
        tokenWait = Math.ceil((1 - this.tokens) / this.refillRatePerMs);
      }

      const wait = Math.max(delayWait, tokenWait);
      if (wait <= 0) {
        this.tokens -= 1;
        this.lastAcquireAt = Date.now();
        return;
      }
      await sleep(wait);
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRatePerMs);
    this.lastRefillAt = now;
  }

  /**
   * Temporarily reduce capacity by `factor` (e.g. 0.5 = halve) for `durationMs`.
   * Called when a 429 slips through so we automatically back off.
   */
  throttle(factor: number, durationMs: number): void {
    const newCapacity = Math.max(1, Math.floor(this.originalCapacity * factor));
    this.capacity = newCapacity;
    this.refillRatePerMs = newCapacity / 60_000;
    this.tokens = Math.min(this.tokens, newCapacity);
    this.throttleResetAt = Date.now() + durationMs;
  }

  private maybeRestoreCapacity(): void {
    if (this.throttleResetAt === 0) return;
    if (Date.now() < this.throttleResetAt) return;
    this.capacity = this.originalCapacity;
    this.refillRatePerMs = this.originalCapacity / 60_000;
    this.throttleResetAt = 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type LimiterOperation =
  | 'searchUsers'
  | 'searchRepliers'
  | 'getFollowers'
  | 'getFollowing'
  | 'getCommunityMembers'
  | 'lookupUserByScreenName'
  | 'getInboxConversations'
  | 'getConversationMessages'
  | 'sendDM'
  | 'followUser';

interface BucketSpec {
  capacityPerMin: number;
  minDelayMs: number;
}

/**
 * Default pacing per operation. Starts conservative since the documented pain
 * point is "429 too fast" — tune up post-rollout based on real headroom.
 */
const DEFAULTS: Record<LimiterOperation, BucketSpec> = {
  searchUsers: { capacityPerMin: 30, minDelayMs: 2000 },
  searchRepliers: { capacityPerMin: 30, minDelayMs: 2000 },
  getFollowers: { capacityPerMin: 30, minDelayMs: 2000 },
  getFollowing: { capacityPerMin: 30, minDelayMs: 2000 },
  getCommunityMembers: { capacityPerMin: 30, minDelayMs: 2000 },
  lookupUserByScreenName: { capacityPerMin: 30, minDelayMs: 2000 },
  getInboxConversations: { capacityPerMin: 30, minDelayMs: 1200 },
  getConversationMessages: { capacityPerMin: 30, minDelayMs: 1200 },
  sendDM: { capacityPerMin: 12, minDelayMs: 4000 },
  followUser: { capacityPerMin: 12, minDelayMs: 5000 },
};

const buckets = new Map<string, TokenBucket>();

function bucketKey(accountId: string, operation: LimiterOperation): string {
  return `${accountId}:${operation}`;
}

function getBucket(accountId: string, operation: LimiterOperation): TokenBucket {
  const key = bucketKey(accountId, operation);
  let bucket = buckets.get(key);
  if (!bucket) {
    const spec = DEFAULTS[operation];
    bucket = new TokenBucket(spec.capacityPerMin, spec.minDelayMs);
    buckets.set(key, bucket);
  }
  return bucket;
}

/**
 * Wait until this `(accountId, operation)` bucket has a free token AND the
 * minimum delay since the last acquire has elapsed.
 *
 * If `accountId` is undefined (no account context), the limiter is a no-op —
 * the only callers without an account are bootstrap/manifest discovery, which
 * we want to run unrestricted.
 */
export async function acquireLimiter(
  accountId: string | undefined,
  operation: LimiterOperation,
): Promise<void> {
  if (!accountId) return;
  await getBucket(accountId, operation).acquire();
}

/**
 * Called when a 429 slips through despite proactive pacing. Halves this
 * `(accountId, operation)` bucket's capacity for one hour so subsequent calls
 * back off automatically.
 */
export function reportRateLimited(
  accountId: string | undefined,
  operation: LimiterOperation,
): void {
  if (!accountId) return;
  getBucket(accountId, operation).throttle(0.5, 60 * 60 * 1000);
}
