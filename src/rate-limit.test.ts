import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter } from './rate-limit.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.stop();
  });

  describe('when disabled', () => {
    beforeEach(() => {
      limiter = new RateLimiter({
        enabled: false,
        maxRequestsPerMinute: 10,
        maxTrackedIPs: 100,
      });
    });

    it('allows all requests', () => {
      for (let i = 0; i < 100; i++) {
        expect(limiter.allow('1.2.3.4')).toBe(true);
      }
    });

    it('remaining returns max', () => {
      expect(limiter.remaining('1.2.3.4')).toBe(10);
    });
  });

  describe('when enabled', () => {
    beforeEach(() => {
      limiter = new RateLimiter({
        enabled: true,
        maxRequestsPerMinute: 5,
        maxTrackedIPs: 100,
      });
    });

    it('allows requests under the limit', () => {
      for (let i = 0; i < 5; i++) {
        expect(limiter.allow('1.2.3.4')).toBe(true);
      }
    });

    it('blocks requests over the limit', () => {
      for (let i = 0; i < 5; i++) {
        limiter.allow('1.2.3.4');
      }
      expect(limiter.allow('1.2.3.4')).toBe(false);
    });

    it('tracks IPs independently', () => {
      for (let i = 0; i < 5; i++) {
        limiter.allow('1.1.1.1');
      }
      // 1.1.1.1 is exhausted
      expect(limiter.allow('1.1.1.1')).toBe(false);
      // 2.2.2.2 is fresh
      expect(limiter.allow('2.2.2.2')).toBe(true);
    });

    it('reports remaining correctly', () => {
      expect(limiter.remaining('1.2.3.4')).toBe(5);
      limiter.allow('1.2.3.4');
      expect(limiter.remaining('1.2.3.4')).toBe(4);
      limiter.allow('1.2.3.4');
      expect(limiter.remaining('1.2.3.4')).toBe(3);
    });

    it('reports 0 remaining when exhausted', () => {
      for (let i = 0; i < 5; i++) {
        limiter.allow('1.2.3.4');
      }
      expect(limiter.remaining('1.2.3.4')).toBe(0);
    });
  });

  describe('sliding window behavior', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      limiter = new RateLimiter({
        enabled: true,
        maxRequestsPerMinute: 3,
        maxTrackedIPs: 100,
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('resets after the window expires', () => {
      // Use up the limit
      limiter.allow('1.2.3.4');
      limiter.allow('1.2.3.4');
      limiter.allow('1.2.3.4');
      expect(limiter.allow('1.2.3.4')).toBe(false);

      // Advance past the 60s window
      vi.advanceTimersByTime(61_000);

      // Should be allowed again
      expect(limiter.allow('1.2.3.4')).toBe(true);
    });

    it('slides the window correctly (partial expiry)', () => {
      // t=0: first request
      limiter.allow('1.2.3.4');

      // t=30s: two more requests
      vi.advanceTimersByTime(30_000);
      limiter.allow('1.2.3.4');
      limiter.allow('1.2.3.4');

      // All 3 used up
      expect(limiter.allow('1.2.3.4')).toBe(false);

      // t=61s: the first request falls out of the window
      vi.advanceTimersByTime(31_000);
      expect(limiter.allow('1.2.3.4')).toBe(true);

      // But only 1 freed up, so after 1 more we're blocked again
      expect(limiter.allow('1.2.3.4')).toBe(false);
    });
  });

  describe('max tracked IPs (fail-open)', () => {
    beforeEach(() => {
      limiter = new RateLimiter({
        enabled: true,
        maxRequestsPerMinute: 5,
        maxTrackedIPs: 2,
      });
    });

    it('fails open when max tracked IPs reached and cannot sweep', () => {
      // Fill up tracking slots
      limiter.allow('1.1.1.1');
      limiter.allow('2.2.2.2');

      // Third IP should fail open (allow) since we can't track it
      // and sweep won't free slots because existing entries are recent
      expect(limiter.allow('3.3.3.3')).toBe(true);
    });
  });
});
