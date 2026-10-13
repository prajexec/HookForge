import { describe, expect, it } from "vitest";

import { createEndpointUrlValidator } from "../src/security/url.js";

describe("endpoint URL policy", () => {
  it("accepts HTTP(S) URLs whose DNS addresses are public", async () => {
    const validator = createEndpointUrlValidator({
      allowPrivate: false,
      resolve: async () => ["93.184.216.34"],
    });

    await expect(validator.validate("https://example.com/hooks")).resolves.toBe(
      "https://example.com/hooks",
    );
  });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com/hook",
    "https://user:password@example.com/hook",
    "https://example.com/hook#fragment",
    "http://localhost:8080/hook",
    "http://169.254.169.254/latest/meta-data",
  ])("rejects unsafe URL %s", async (url) => {
    const validator = createEndpointUrlValidator({
      allowPrivate: false,
      resolve: async () => ["93.184.216.34"],
    });

    await expect(validator.validate(url)).rejects.toMatchObject({
      code: expect.stringMatching(/INVALID_ENDPOINT_URL|UNSAFE_ENDPOINT_URL/),
      statusCode: 400,
    });
  });

  it("rejects public hostnames that resolve to private addresses", async () => {
    const validator = createEndpointUrlValidator({
      allowPrivate: false,
      resolve: async () => ["10.0.0.15"],
    });

    await expect(
      validator.validate("https://attacker.example/hook"),
    ).rejects.toMatchObject({
      code: "UNSAFE_ENDPOINT_URL",
    });
  });
});
