import { describe, expect, it } from "vitest";

import { parseWorkerConfig } from "../src/config.js";

describe("worker configuration", () => {
  it("provides conservative local defaults", () => {
    expect(parseWorkerConfig({ NODE_ENV: "test" })).toMatchObject({
      WORKER_CONCURRENCY: 5,
      WORKER_LEASE_SECONDS: 60,
      WORKER_REQUEST_TIMEOUT_MS: 10_000,
      MAX_DELIVERY_ATTEMPTS: 8,
    });
  });

  it("rejects a lease that can expire during the request deadline", () => {
    expect(() =>
      parseWorkerConfig({
        NODE_ENV: "test",
        WORKER_LEASE_SECONDS: "5",
        WORKER_REQUEST_TIMEOUT_MS: "10000",
      }),
    ).toThrow("WORKER_LEASE_SECONDS must exceed the request timeout");
  });
});
