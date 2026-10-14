import { tooManyRequests } from "./errors.js";

export interface RateLimitRule {
  maxRequests: number;
  windowSeconds: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number | null;
}

export interface RateLimiter {
  consume(key: string, rule: RateLimitRule): RateLimitDecision;
}

interface RateLimitEntry {
  count: number;
  lastSeenAt: number;
  limit: number;
  windowStartedAt: number;
  windowSeconds: number;
}

export interface InMemoryRateLimiterOptions {
  maxEntries: number;
  now?: () => number;
}

/**
 * A fixed-window limiter for a single API process.
 *
 * Entries are bounded and expired entries are reclaimed when the map reaches
 * capacity. This intentionally provides no cross-process coordination; a
 * shared store is required if the API is scaled horizontally.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly now: () => number;

  public constructor(private readonly options: InMemoryRateLimiterOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new Error("maxEntries must be a positive integer");
    }
    this.now = options.now ?? Date.now;
  }

  public consume(key: string, rule: RateLimitRule): RateLimitDecision {
    if (
      !Number.isInteger(rule.maxRequests) ||
      rule.maxRequests < 1 ||
      !Number.isInteger(rule.windowSeconds) ||
      rule.windowSeconds < 1
    ) {
      throw new Error("Rate limit rules must use positive integer values");
    }

    const now = this.now();
    let entry = this.entries.get(key);
    const ruleChanged =
      entry &&
      (entry.limit !== rule.maxRequests ||
        entry.windowSeconds !== rule.windowSeconds);
    const windowExpired =
      entry &&
      (now < entry.windowStartedAt ||
        now >= entry.windowStartedAt + entry.windowSeconds * 1_000);

    if (entry && (ruleChanged || windowExpired)) {
      this.entries.delete(key);
      entry = undefined;
    }

    if (!entry) {
      this.ensureCapacity(now);
      entry = {
        count: 0,
        lastSeenAt: now,
        limit: rule.maxRequests,
        windowStartedAt: now,
        windowSeconds: rule.windowSeconds,
      };
      this.entries.set(key, entry);
    }

    entry.lastSeenAt = now;
    if (entry.count >= entry.limit) {
      return {
        allowed: false,
        limit: entry.limit,
        remaining: 0,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(
            (entry.windowStartedAt + entry.windowSeconds * 1_000 - now) / 1_000,
          ),
        ),
      };
    }

    entry.count += 1;
    return {
      allowed: true,
      limit: entry.limit,
      remaining: entry.limit - entry.count,
      retryAfterSeconds: null,
    };
  }

  public get size(): number {
    return this.entries.size;
  }

  private ensureCapacity(now: number): void {
    if (this.entries.size < this.options.maxEntries) {
      return;
    }

    for (const [key, entry] of this.entries) {
      if (now >= entry.windowStartedAt + entry.windowSeconds * 1_000) {
        this.entries.delete(key);
      }
    }
    if (this.entries.size < this.options.maxEntries) {
      return;
    }

    let oldestKey: string | undefined;
    let oldestSeenAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.lastSeenAt < oldestSeenAt) {
        oldestKey = key;
        oldestSeenAt = entry.lastSeenAt;
      }
    }
    if (oldestKey !== undefined) {
      this.entries.delete(oldestKey);
    }
  }
}

export function enforceRateLimit(
  rateLimiter: RateLimiter,
  key: string,
  rule: RateLimitRule,
): void {
  const decision = rateLimiter.consume(key, rule);
  if (!decision.allowed) {
    throw tooManyRequests(decision.retryAfterSeconds ?? 1);
  }
}
