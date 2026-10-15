import { createHash, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "redis";

import { parseConfig } from "../../apps/api/src/config.js";
import {
  RedisRateLimiter,
  type RedisRateLimitClient,
} from "../../apps/api/src/rate-limit.js";

const REDIS_KEY_PREFIX = "hookforge:rate-limit:v1:";
const runId = randomUUID();
const redisConfig = parseConfig({
  ...process.env,
  NODE_ENV: "test",
  RATE_LIMIT_ENABLED: "true",
});
const redisClients = [
  createClient({ url: redisConfig.REDIS_URL }),
  createClient({ url: redisConfig.REDIS_URL }),
];
const extraRedisClients = new Set<ReturnType<typeof createClient>>();
const createdRedisKeys = new Set<string>();

type RedisClient = ReturnType<typeof createClient>;

function rateLimitRedisKey(rawKey: string): string {
  const key = `${REDIS_KEY_PREFIX}${createHash("sha256")
    .update(rawKey)
    .digest("hex")}`;
  createdRedisKeys.add(key);
  return key;
}

function redisRateLimitClient(client: RedisClient): RedisRateLimitClient & {
  ping: () => Promise<string>;
} {
  return {
    eval: async (script, options) =>
      client.eval(script, {
        keys: options.keys,
        arguments: options.arguments,
      }),
    ping: () => client.ping(),
  };
}

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

async function closeRedisClient(client: RedisClient): Promise<void> {
  if (client.isOpen) {
    await client.quit();
  }
}

beforeAll(async () => {
  await Promise.all(redisClients.map((client) => client.connect()));
  expect(await redisClients[0]!.ping()).toBe("PONG");
});

afterEach(async () => {
  if (createdRedisKeys.size > 0) {
    await redisClients[0]!.del([...createdRedisKeys]);
    createdRedisKeys.clear();
  }

  await Promise.all(
    [...extraRedisClients].map(async (client) => {
      await closeRedisClient(client);
      extraRedisClients.delete(client);
    }),
  );
});

afterAll(async () => {
  await Promise.all(redisClients.map(closeRedisClient));
});

describe("Redis-backed rate limiting", () => {
  it("shares one atomic bucket across independent clients and enforces the exact cap", async () => {
    const limiterOne = new RedisRateLimiter(
      redisRateLimitClient(redisClients[0]!),
    );
    const limiterTwo = new RedisRateLimiter(
      redisRateLimitClient(redisClients[1]!),
    );
    const rawKey = `concurrency:${runId}:${randomUUID()}`;
    const redisKey = rateLimitRedisKey(rawKey);
    const rule = { maxRequests: 7, windowSeconds: 120 };

    const decisions = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 === 0 ? limiterOne : limiterTwo).consume(rawKey, rule),
      ),
    );
    const allowed = decisions.filter((decision) => decision.allowed);
    const rejected = decisions.filter((decision) => !decision.allowed);

    expect(allowed).toHaveLength(rule.maxRequests);
    expect(rejected).toHaveLength(33);
    expect(
      decisions.every((decision) => decision.limit === rule.maxRequests),
    ).toBe(true);
    expect(allowed.every((decision) => decision.remaining >= 0)).toBe(true);
    expect(allowed.some((decision) => decision.remaining === 0)).toBe(true);
    expect(
      rejected.every(
        (decision) =>
          decision.remaining === 0 && (decision.retryAfterSeconds ?? 0) > 0,
      ),
    ).toBe(true);

    expect(redisKey).toBe(
      `${REDIS_KEY_PREFIX}${createHash("sha256").update(rawKey).digest("hex")}`,
    );
    expect(await redisClients[0]!.exists(redisKey)).toBe(1);
    expect(await redisClients[0]!.keys(`${redisKey}:*`)).toEqual([]);
  });

  it("keeps different raw keys isolated", async () => {
    const limiter = new RedisRateLimiter(
      redisRateLimitClient(redisClients[0]!),
    );
    const firstRawKey = `isolation:first:${runId}:${randomUUID()}`;
    const secondRawKey = `isolation:second:${runId}:${randomUUID()}`;
    const firstRedisKey = rateLimitRedisKey(firstRawKey);
    const secondRedisKey = rateLimitRedisKey(secondRawKey);
    const rule = { maxRequests: 2, windowSeconds: 60 };

    expect((await limiter.consume(firstRawKey, rule)).allowed).toBe(true);
    expect((await limiter.consume(firstRawKey, rule)).allowed).toBe(true);
    expect((await limiter.consume(firstRawKey, rule)).allowed).toBe(false);

    await expect(limiter.consume(secondRawKey, rule)).resolves.toMatchObject({
      allowed: true,
      limit: 2,
      remaining: 1,
      retryAfterSeconds: null,
    });
    expect(await redisClients[0]!.exists(firstRedisKey)).toBe(1);
    expect(await redisClients[0]!.exists(secondRedisKey)).toBe(1);
  });

  it("refreshes its one-window TTL on access and expires the bucket", async () => {
    const limiter = new RedisRateLimiter(
      redisRateLimitClient(redisClients[0]!),
    );
    const rawKey = `ttl:${runId}:${randomUUID()}`;
    const redisKey = rateLimitRedisKey(rawKey);
    const rule = { maxRequests: 1, windowSeconds: 2 };

    await expect(limiter.consume(rawKey, rule)).resolves.toMatchObject({
      allowed: true,
      limit: 1,
      remaining: 0,
      retryAfterSeconds: null,
    });
    const initialTtlMs = await redisClients[0]!.pTTL(redisKey);
    expect(initialTtlMs).toBeGreaterThan(0);
    expect(initialTtlMs).toBeLessThanOrEqual(rule.windowSeconds * 1_000);

    await new Promise((resolve) => setTimeout(resolve, 800));
    const beforeRefreshTtlMs = await redisClients[0]!.pTTL(redisKey);
    await expect(limiter.consume(rawKey, rule)).resolves.toMatchObject({
      allowed: false,
      limit: 1,
      remaining: 0,
    });
    const afterRefreshTtlMs = await redisClients[0]!.pTTL(redisKey);
    expect(afterRefreshTtlMs).toBeGreaterThan(beforeRefreshTtlMs);
    expect(afterRefreshTtlMs).toBeGreaterThan(1_000);

    await waitFor(
      async () => (await redisClients[0]!.exists(redisKey)) === 0,
      3_500,
    );
    await expect(limiter.consume(rawKey, rule)).resolves.toMatchObject({
      allowed: true,
      limit: 1,
      remaining: 0,
      retryAfterSeconds: null,
    });
  });

  it("refills continuously and reports a rounded retry delay", async () => {
    const limiter = new RedisRateLimiter(
      redisRateLimitClient(redisClients[0]!),
    );
    const rawKey = `fractional:${runId}:${randomUUID()}`;
    rateLimitRedisKey(rawKey);
    const rule = { maxRequests: 1, windowSeconds: 2 };

    await expect(limiter.consume(rawKey, rule)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
      retryAfterSeconds: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(limiter.consume(rawKey, rule)).resolves.toMatchObject({
      allowed: false,
      limit: 1,
      remaining: 0,
      retryAfterSeconds: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await expect(limiter.consume(rawKey, rule)).resolves.toMatchObject({
      allowed: true,
      limit: 1,
      remaining: 0,
      retryAfterSeconds: null,
    });
  });
});
