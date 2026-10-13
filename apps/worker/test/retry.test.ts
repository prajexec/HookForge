import { describe, expect, it } from "vitest";

import {
  calculateBackoffDelay,
  classifyHttpStatus,
  parseRetryAfter,
} from "../src/retry.js";

describe("delivery retry policy", () => {
  it.each([
    [200, "success", "http_success"],
    [408, "retry", "http_timeout"],
    [429, "retry", "http_rate_limited"],
    [503, "retry", "http_server_error"],
    [400, "failed", "http_client_error"],
    [302, "failed", "http_redirect_blocked"],
  ])("classifies HTTP %s", (status, outcome, classification) => {
    expect(classifyHttpStatus(status)).toEqual({ outcome, classification });
  });

  it("calculates capped exponential backoff with deterministic jitter", () => {
    const policy = {
      initialDelayMs: 1_000,
      maxDelayMs: 5_000,
      jitterRatio: 0.2,
    };

    expect(calculateBackoffDelay(1, policy, 0.5)).toBe(1_000);
    expect(calculateBackoffDelay(3, policy, 0)).toBe(3_200);
    expect(calculateBackoffDelay(10, policy, 1)).toBe(5_000);
  });

  it("honors bounded Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfter("5", 1_000, 3_000)).toBe(3_000);
    expect(
      parseRetryAfter(
        "Wed, 21 Oct 2015 07:28:00 GMT",
        Date.parse("Wed, 21 Oct 2015 07:27:00 GMT"),
        120_000,
      ),
    ).toBe(60_000);
    expect(parseRetryAfter("not-a-date", 1_000, 3_000)).toBeNull();
  });
});
