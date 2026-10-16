import { describe, expect, it } from 'bun:test';
import { TokenBucket } from '../../src/x/token-bucket';

describe('TokenBucket', () => {
  it('returns immediately for the first acquire on a fresh bucket', async () => {
    const b = new TokenBucket(60, 0);
    const t0 = Date.now();
    await b.acquire();
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('enforces minDelayMs between consecutive acquires', async () => {
    const b = new TokenBucket(60, 200);
    await b.acquire();
    const t0 = Date.now();
    await b.acquire();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(500);
  });

  it('serialises concurrent acquires through the same bucket', async () => {
    const b = new TokenBucket(60, 150);
    const timestamps: number[] = [];
    await Promise.all(
      Array.from({ length: 3 }, () =>
        b.acquire().then(() => timestamps.push(Date.now())),
      ),
    );
    expect(timestamps.length).toBe(3);
    // 2nd at >= 150ms after 1st, 3rd at >= 150ms after 2nd.
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(130);
    expect(timestamps[2] - timestamps[1]).toBeGreaterThanOrEqual(130);
  });

  it('halves throughput after throttle()', async () => {
    // Capacity 600/min = 10/sec → ~100ms between acquires once burst is drained.
    const b = new TokenBucket(600, 0);
    // Drain initial bucket.
    for (let i = 0; i < 600; i++) await b.acquire();

    // Time one acquire on full capacity baseline.
    const baselineStart = Date.now();
    await b.acquire();
    const baseline = Date.now() - baselineStart;

    // Throttle to half — refill rate drops, so we wait longer.
    b.throttle(0.5, 60_000);
    const throttledStart = Date.now();
    await b.acquire();
    const throttled = Date.now() - throttledStart;

    expect(throttled).toBeGreaterThan(baseline);
  });
});
