import { describe, expect, it } from "vitest";

import { deliverJob } from "../src/delivery.js";
import { verifyWebhookSignature } from "../src/signature.js";
import {
  deliveryJob,
  encryptFixtureSecret,
  encryptionKey,
} from "./fixtures.js";

describe("HTTP delivery", () => {
  it("sends a signed raw JSON body with bounded request behavior", async () => {
    let receivedBody = "";
    let receivedHeaders: Headers | undefined;
    const result = await deliverJob(deliveryJob(), {
      encryptionKey,
      allowPrivateEndpoints: false,
      requestTimeoutMs: 1_000,
      maxResponseBytes: 100,
      requestImpl: async (_target, init) => {
        receivedBody = String(init?.body);
        receivedHeaders = new Headers(init?.headers);
        return new Response("accepted", { status: 200 });
      },
    });

    expect(result.outcome).toBe("success");
    expect(result.httpStatusCode).toBe(200);
    expect(receivedHeaders?.get("x-hookforge-event-id")).toBeTruthy();
    expect(
      verifyWebhookSignature({
        secret: "whsec_test_secret",
        timestampSeconds: Number(receivedHeaders?.get("x-hookforge-timestamp")),
        rawBody: receivedBody,
        signature: receivedHeaders?.get("x-hookforge-signature") ?? "",
        nowSeconds: Number(receivedHeaders?.get("x-hookforge-timestamp")),
        toleranceSeconds: 1,
      }),
    ).toBe(true);
  });

  it("treats oversized receiver responses as terminal failures", async () => {
    const result = await deliverJob(deliveryJob(), {
      encryptionKey,
      allowPrivateEndpoints: false,
      requestTimeoutMs: 1_000,
      maxResponseBytes: 4,
      requestImpl: async () => new Response("too-large", { status: 200 }),
    });

    expect(result.outcome).toBe("failed");
    expect(result.errorClassification).toBe("response_too_large");
  });

  it("adds encrypted static headers without allowing integrity overrides", async () => {
    let receivedHeaders: Headers | undefined;
    const result = await deliverJob(
      deliveryJob({
        encryptedStaticHeaders: {
          "x-api-key": encryptFixtureSecret("api-key"),
          "x-hookforge-signature": encryptFixtureSecret("forged"),
        },
      }),
      {
        encryptionKey,
        allowPrivateEndpoints: false,
        requestTimeoutMs: 1_000,
        maxResponseBytes: 100,
        requestImpl: async (_target, init) => {
          receivedHeaders = new Headers(init?.headers);
          return new Response("accepted", { status: 200 });
        },
      },
    );

    expect(result.outcome).toBe("success");
    expect(receivedHeaders?.get("x-api-key")).toBe("api-key");
    expect(receivedHeaders?.get("x-hookforge-signature")).toMatch(/^v1=/);
  });

  it("continues the persisted queue trace into the receiver request", async () => {
    let receivedHeaders: Headers | undefined;
    const result = await deliverJob(
      deliveryJob({
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      }),
      {
        encryptionKey,
        allowPrivateEndpoints: false,
        requestTimeoutMs: 1_000,
        maxResponseBytes: 100,
        requestImpl: async (_target, init) => {
          receivedHeaders = new Headers(init?.headers);
          return new Response("accepted", { status: 200 });
        },
      },
    );

    expect(result.outcome).toBe("success");
    expect(receivedHeaders?.get("traceparent")).toMatch(
      /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/,
    );
  });

  it("rejects private destinations again at delivery time", async () => {
    let called = false;
    const result = await deliverJob(
      deliveryJob({ endpointUrl: "http://127.0.0.1:8080/hook" }),
      {
        encryptionKey,
        allowPrivateEndpoints: false,
        requestTimeoutMs: 1_000,
        maxResponseBytes: 100,
        requestImpl: async () => {
          called = true;
          return new Response("unexpected", { status: 200 });
        },
      },
    );

    expect(result.outcome).toBe("failed");
    expect(result.errorClassification).toBe("ssrf_or_secret_validation_failed");
    expect(called).toBe(false);
  });
});
