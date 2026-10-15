import { createHash } from "node:crypto";

import { AppError, tooManyRequests } from "./errors.js";

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
  consume(
    key: string,
    rule: RateLimitRule,
  ): RateLimitDecision | Promise<RateLimitDecision>;
}

export interface RedisRateLimitClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

const REDIS_KEY_PREFIX = "hookforge:rate-limit:v1:";
const MAX_WINDOW_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);

// One key and one EVAL keep the entire read/refill/consume/write atomic, including
// across replicas and Redis Cluster slots. Redis TIME avoids API clock skew.
const CONSUME_TOKEN_SCRIPT = `
local capacity = tonumber(ARGV[1])
local window_seconds = tonumber(ARGV[2])
local window_ms = window_seconds * 1000
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + tonumber(time[2]) / 1000
local state = redis.call("HMGET", KEYS[1], "tokens", "updated_at")
local tokens = capacity
local updated_at = now

if state[1] or state[2] then
  tokens = tonumber(state[1])
  updated_at = tonumber(state[2])
  if not tokens or tokens ~= tokens or tokens < 0 or tokens > 9007199254740991
    or not updated_at or updated_at ~= updated_at or updated_at < 0
    or updated_at > 9007199254740991 then
    return redis.error_reply("Invalid rate limit state")
  end
end

-- Preserve existing quota on policy changes; only clamp/refill at the current
-- capacity and rate. A backwards clock must not grant the same refill twice.
local elapsed = math.max(0, now - updated_at)
tokens = math.min(capacity, tokens + math.min(elapsed / window_ms, 1) * capacity)
updated_at = math.max(now, updated_at)

local allowed = 0
local retry_after = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_after = math.max(1, math.ceil((1 - tokens) / capacity * (window_ms / 1000)))
end

-- Lua's default number-to-string conversion loses precision. Preserve fractional
-- tokens and timestamps, including at the safe-integer capacity boundary.
redis.call("HSET", KEYS[1], "tokens", string.format("%.17g", tokens),
  "updated_at", string.format("%.17g", updated_at))
-- Even an empty bucket fully replenishes in one window, so retain it no longer.
redis.call("PEXPIRE", KEYS[1], window_ms)
return {allowed, math.floor(tokens), retry_after}
`;

function validateRule(rule: RateLimitRule): void {
  if (
    !Number.isSafeInteger(rule.maxRequests) ||
    rule.maxRequests < 1 ||
    !Number.isSafeInteger(rule.windowSeconds) ||
    rule.windowSeconds < 1
  ) {
    throw new RangeError(
      "Rate limit rules must use positive safe integer values",
    );
  }
  if (rule.windowSeconds > MAX_WINDOW_SECONDS) {
    throw new RangeError(
      "Rate limit window in milliseconds must be a safe integer",
    );
  }
}

/**
 * Shared production token bucket. Redis failures fail closed with a sanitized
 * 503; there is no process-local fallback. The client adapter must disable its
 * offline queue and bound command execution with a timeout/abort.
 */
export class RedisRateLimiter implements RateLimiter {
  public constructor(private readonly client: RedisRateLimitClient) {}

  public async consume(
    key: string,
    rule: RateLimitRule,
  ): Promise<RateLimitDecision> {
    validateRule(rule);
    if (typeof key !== "string") {
      throw new TypeError("Rate limit key must be a string");
    }
    const { maxRequests, windowSeconds } = rule;
    // Never put raw identities, cluster hash tags, or policy values in the key.
    const redisKey =
      REDIS_KEY_PREFIX + createHash("sha256").update(key).digest("hex");

    try {
      const reply = await this.client.eval(CONSUME_TOKEN_SCRIPT, {
        keys: [redisKey],
        arguments: [String(maxRequests), String(windowSeconds)],
      });
      if (!Array.isArray(reply) || reply.length !== 3) {
        throw new Error("Invalid rate limit reply");
      }
      const [allowed, remaining, retryAfterSeconds] = reply as unknown[];
      if (
        (allowed !== 0 && allowed !== 1) ||
        typeof remaining !== "number" ||
        !Number.isSafeInteger(remaining) ||
        remaining < 0 ||
        remaining >= maxRequests ||
        typeof retryAfterSeconds !== "number" ||
        !Number.isSafeInteger(retryAfterSeconds) ||
        (allowed === 1
          ? retryAfterSeconds !== 0
          : remaining !== 0 ||
            retryAfterSeconds < 1 ||
            retryAfterSeconds > Math.ceil(windowSeconds / maxRequests))
      ) {
        throw new Error("Invalid rate limit reply");
      }

      return {
        allowed: allowed === 1,
        limit: maxRequests,
        remaining,
        retryAfterSeconds: allowed === 1 ? null : retryAfterSeconds,
      };
    } catch {
      // Do not attach the Redis error as a cause: it may contain credentials,
      // connection details, keys, or script contents.
      throw new AppError(
        503,
        "RATE_LIMIT_UNAVAILABLE",
        "Rate limiting is temporarily unavailable",
      );
    }
  }
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
 * A fixed-window limiter for explicit test injection only.
 *
 * Entries are bounded and expired entries are reclaimed when the map reaches
 * capacity. This provides no cross-process coordination and must never be used
 * as a production default or as a fallback when Redis is unavailable.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly now: () => number;

  public constructor(private readonly options: InMemoryRateLimiterOptions) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive safe integer");
    }
    this.now = options.now ?? Date.now;
  }

  public consume(key: string, rule: RateLimitRule): RateLimitDecision {
    validateRule(rule);

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

export async function enforceRateLimit(
  rateLimiter: RateLimiter,
  key: string,
  rule: RateLimitRule,
): Promise<void> {
  const decision = await rateLimiter.consume(key, rule);
  if (!decision.allowed) {
    throw tooManyRequests(decision.retryAfterSeconds ?? 1);
  }
}
