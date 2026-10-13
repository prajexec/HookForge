import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.js";

describe("environment configuration", () => {
  it("supplies safe local defaults", () => {
    expect(parseConfig({ NODE_ENV: "test" })).toMatchObject({
      NODE_ENV: "test",
      HOST: "0.0.0.0",
      PORT: 3000,
      CORS_ORIGIN: "http://localhost:5173",
    });
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
