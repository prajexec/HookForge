import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { requestPinned } from "../src/http-client.js";
import { resolveDeliveryTarget, type ResolvedAddress } from "../src/network.js";

describe("pinned outbound delivery networking", () => {
  it("uses the validated address while retaining the hostname in Host", async () => {
    let resolverCalls = 0;
    let receivedHost: string | undefined;
    const server = createServer((request, response) => {
      receivedHost = request.headers.host;
      response.end("pinned");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("test server did not expose a port");
    }

    try {
      const resolveAddresses = async (
        hostname: string,
      ): Promise<ResolvedAddress[]> => {
        void hostname;
        resolverCalls += 1;
        return [{ address: "127.0.0.1", family: 4 }];
      };
      const target = await resolveDeliveryTarget(
        `http://rebind.test:${address.port}/hook`,
        true,
        resolveAddresses,
      );
      const response = await requestPinned(target, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "payload",
        signal: new AbortController().signal,
      });

      expect(await response.text()).toBe("pinned");
      expect(receivedHost).toBe(`rebind.test:${address.port}`);
      expect(target.address).toBe("127.0.0.1");
      expect(resolverCalls).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects a hostname when any DNS answer is private", async () => {
    await expect(
      resolveDeliveryTarget(
        "https://receiver.example/hook",
        false,
        async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.8", family: 4 },
        ],
      ),
    ).rejects.toThrow("unsafe_endpoint_url");
  });

  it("does not resolve an IP literal a second time", async () => {
    let resolverCalls = 0;
    const target = await resolveDeliveryTarget(
      "http://93.184.216.34/hook",
      false,
      async () => {
        resolverCalls += 1;
        return [{ address: "198.51.100.4", family: 4 }];
      },
    );

    expect(target.address).toBe("93.184.216.34");
    expect(resolverCalls).toBe(0);
  });
});
