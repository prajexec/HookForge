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
});
