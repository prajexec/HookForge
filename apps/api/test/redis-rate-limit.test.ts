import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AppError } from "../src/errors.js";
import {
  enforceRateLimit,
  RedisRateLimiter,
  type RedisRateLimitClient,
  type RateLimitRule,
} from "../src/rate-limit.js";

const rule: RateLimitRule = { maxRequests: 3, windowSeconds: 10 };

function clientReturning(reply: unknown) {
  const evalMock = vi.fn(async () => reply);
  const client: RedisRateLimitClient = { eval: evalMock };
  return { client, evalMock };
}

describe("RedisRateLimiter", () => {
  it("uses one hashed, policy-independent key and a server-time script", async () => {
    const { client, evalMock } = clientReturning([1, 1, 0]);
    const limiter = new RedisRateLimiter(client);
    const key = "auth:client/with spaces?and=secrets";

    await limiter.consume(key, rule);
    await limiter.consume(key, { maxRequests: 8, windowSeconds: 30 });

    expect(evalMock).toHaveBeenCalledTimes(2);
    expect(evalMock.mock.calls[0]?.[0]).toContain('redis.call("TIME")');
    expect(evalMock.mock.calls[0]?.[0]).toContain('redis.call("PEXPIRE"');
    expect(evalMock.mock.calls[0]?.[0]).toContain('redis.call("HSET"');

    const expectedKey =
      "hookforge:rate-limit:v1:" +
      createHash("sha256").update(key).digest("hex");
    expect(evalMock.mock.calls[0]?.[1]).toEqual({
      keys: [expectedKey],
      arguments: ["3", "10"],
    });
    expect(evalMock.mock.calls[1]?.[1]).toMatchObject({
      keys: [expectedKey],
    });
    expect(evalMock.mock.calls[0]?.[1]).not.toEqual(
      expect.objectContaining({ keys: [expect.stringContaining(key)] }),
    );
  });

  it.each([
    [{ maxRequests: 0, windowSeconds: 10 }, "maxRequests"],
    [{ maxRequests: 1, windowSeconds: 0 }, "windowSeconds"],
    [{ maxRequests: 1.5, windowSeconds: 10 }, "fractional"],
    [{ maxRequests: Number.MAX_SAFE_INTEGER + 1, windowSeconds: 10 }, "unsafe"],
    [
      {
        maxRequests: 1,
        windowSeconds: Math.floor(Number.MAX_SAFE_INTEGER / 1_000) + 1,
      },
      "unsafe milliseconds",
    ],
  ])("rejects invalid rule values (%s)", async (invalidRule) => {
    const { client, evalMock } = clientReturning([1, 0, 0]);
    const limiter = new RedisRateLimiter(client);

    await expect(
      limiter.consume("client", invalidRule as RateLimitRule),
    ).rejects.toThrow(RangeError);
    expect(evalMock).not.toHaveBeenCalled();
  });

  it("accepts the safe integer boundaries that fit the Redis TTL", async () => {
    const { client, evalMock } = clientReturning([1, 0, 0]);
    const limiter = new RedisRateLimiter(client);
    const boundaryRule = {
      maxRequests: Number.MAX_SAFE_INTEGER,
      windowSeconds: Math.floor(Number.MAX_SAFE_INTEGER / 1_000),
    };

    await expect(limiter.consume("boundary", boundaryRule)).resolves.toEqual({
      allowed: true,
      limit: Number.MAX_SAFE_INTEGER,
      remaining: 0,
      retryAfterSeconds: null,
    });
    expect(evalMock.mock.calls[0]?.[1]).toMatchObject({
      arguments: [
        String(Number.MAX_SAFE_INTEGER),
        String(Math.floor(Number.MAX_SAFE_INTEGER / 1_000)),
      ],
    });
  });

  it("translates allowed and denied Redis replies into decisions", async () => {
    const allowed = new RedisRateLimiter(clientReturning([1, 2, 0]).client);
    await expect(allowed.consume("allowed", rule)).resolves.toEqual({
      allowed: true,
      limit: 3,
      remaining: 2,
      retryAfterSeconds: null,
    });

    const denied = new RedisRateLimiter(clientReturning([0, 0, 4]).client);
    await expect(denied.consume("denied", rule)).resolves.toEqual({
      allowed: false,
      limit: 3,
      remaining: 0,
      retryAfterSeconds: 4,
    });
  });

  it.each([
    null,
    [],
    [1, 2],
    [2, 2, 0],
    [1, 3, 0],
    [0, 1, 1],
    [0, 0, 0],
    [1, 0, 1],
    [1, "2", 0],
  ])("rejects malformed Redis reply %s", async (reply) => {
    const limiter = new RedisRateLimiter(clientReturning(reply).client);

    await expect(limiter.consume("client", rule)).rejects.toMatchObject({
      statusCode: 503,
      code: "RATE_LIMIT_UNAVAILABLE",
    });
  });

  it("sanitizes Redis failures and does not fall back locally", async () => {
    const secret = "redis://:super-secret-password@example.invalid";
    const client: RedisRateLimitClient = {
      eval: vi.fn(async () => {
        throw new Error(secret);
      }),
    };

    const error = await new RedisRateLimiter(client)
      .consume("client", rule)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      statusCode: 503,
      code: "RATE_LIMIT_UNAVAILABLE",
      message: "Rate limiting is temporarily unavailable",
    });
    expect(error).not.toMatchObject({
      message: expect.stringContaining(secret),
    });
  });
});

describe("enforceRateLimit", () => {
  it("awaits async test doubles before allowing or rejecting the request", async () => {
    let resolved = false;
    const rateLimiter = {
      consume: vi.fn(async () => {
        await Promise.resolve();
        resolved = true;
        return {
          allowed: false,
          limit: 3,
          remaining: 0,
          retryAfterSeconds: 2,
        };
      }),
    };

    await expect(
      enforceRateLimit(rateLimiter, "client", rule),
    ).rejects.toMatchObject({
      statusCode: 429,
      code: "RATE_LIMIT_EXCEEDED",
      retryAfterSeconds: 2,
    });
    expect(resolved).toBe(true);
  });

  it("accepts synchronous test doubles through the RateLimiter contract", async () => {
    const rateLimiter = {
      consume: () => ({
        allowed: true,
        limit: 3,
        remaining: 2,
        retryAfterSeconds: null,
      }),
    };

    await expect(
      enforceRateLimit(rateLimiter, "client", rule),
    ).resolves.toBeUndefined();
  });
});
