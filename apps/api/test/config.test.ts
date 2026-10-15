import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.js";

describe("environment configuration", () => {
  it("supplies safe local defaults", () => {
    expect(parseConfig({ NODE_ENV: "test" })).toMatchObject({
      NODE_ENV: "test",
      HOST: "0.0.0.0",
      PORT: 3000,
      CORS_ORIGIN: "http://localhost:5173",
      RATE_LIMIT_ENABLED: false,
      RATE_LIMIT_MAX_ENTRIES: 10_000,
      RATE_LIMIT_AUTH_MAX_REQUESTS: 10,
      RATE_LIMIT_AUTH_WINDOW_SECONDS: 60,
      RATE_LIMIT_EVENT_MAX_REQUESTS: 120,
      RATE_LIMIT_EVENT_WINDOW_SECONDS: 60,
    });
  });

  it("parses explicit rate limit settings", () => {
    expect(
      parseConfig({
        NODE_ENV: "test",
        RATE_LIMIT_ENABLED: "true",
        RATE_LIMIT_MAX_ENTRIES: "25",
        RATE_LIMIT_AUTH_MAX_REQUESTS: "4",
        RATE_LIMIT_AUTH_WINDOW_SECONDS: "30",
        RATE_LIMIT_EVENT_MAX_REQUESTS: "50",
        RATE_LIMIT_EVENT_WINDOW_SECONDS: "45",
      }),
    ).toMatchObject({
      RATE_LIMIT_ENABLED: true,
      RATE_LIMIT_MAX_ENTRIES: 25,
      RATE_LIMIT_AUTH_MAX_REQUESTS: 4,
      RATE_LIMIT_AUTH_WINDOW_SECONDS: 30,
      RATE_LIMIT_EVENT_MAX_REQUESTS: 50,
      RATE_LIMIT_EVENT_WINDOW_SECONDS: 45,
    });
  });

  it("accepts empty optional Vault fields in local Compose defaults", () => {
    expect(
      parseConfig({ NODE_ENV: "test", VAULT_NAMESPACE: "", VAULT_TOKEN: "" }),
    ).toMatchObject({ ENVELOPE_PROVIDER: "legacy" });
  });

  it("rejects invalid ports", () => {
    expect(() => parseConfig({ PORT: "70000" })).toThrow(
      "Invalid environment configuration",
    );
  });

  it("requires a key and rejects private endpoints in production", () => {
    expect(() => parseConfig({ NODE_ENV: "production" })).toThrow(
      "SECRET_ENCRYPTION_KEY is required in production",
    );
    expect(() =>
      parseConfig({
        NODE_ENV: "production",
        SECRET_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        ALLOW_PRIVATE_ENDPOINTS: "true",
      }),
    ).toThrow("ALLOW_PRIVATE_ENDPOINTS cannot be enabled in production");
  });
});
