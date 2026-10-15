import { describe, expect, it } from "vitest";

import { parseWorkerConfig } from "../src/config.js";

describe("worker configuration", () => {
  it("provides conservative local defaults", () => {
    expect(parseWorkerConfig({ NODE_ENV: "test" })).toMatchObject({
      WORKER_CONCURRENCY: 5,
      WORKER_MAX_IN_FLIGHT_PER_ENDPOINT: 1,
      WORKER_MAX_IN_FLIGHT_PER_PROJECT: 5,
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

  it("accepts empty optional Vault fields in local Compose defaults", () => {
    expect(
      parseWorkerConfig({
        NODE_ENV: "test",
        VAULT_NAMESPACE: "",
        VAULT_TOKEN: "",
      }),
    ).toMatchObject({ ENVELOPE_PROVIDER: "legacy" });
  });

  it("requires positive endpoint and project in-flight quotas", () => {
    expect(() =>
      parseWorkerConfig({
        NODE_ENV: "test",
        WORKER_MAX_IN_FLIGHT_PER_ENDPOINT: "0",
      }),
    ).toThrow("WORKER_MAX_IN_FLIGHT_PER_ENDPOINT");
    expect(() =>
      parseWorkerConfig({
        NODE_ENV: "test",
        WORKER_MAX_IN_FLIGHT_PER_PROJECT: "1001",
      }),
    ).toThrow("WORKER_MAX_IN_FLIGHT_PER_PROJECT");
  });
});
