import { describe, expect, it } from "vitest";

import {
  buildSignatureHeaders,
  verifyWebhookSignature,
} from "../src/signature.js";

describe("webhook signatures", () => {
  it("signs the exact timestamped body and verifies it", () => {
    const input = {
      eventId: "event_123",
      timestampSeconds: 1_700_000_000,
      rawBody: '{"id":"event_123","payload":{"ok":true}}',
      secret: "whsec_test_secret",
    };
    const headers = buildSignatureHeaders(input);

    expect(headers["x-hookforge-event-id"]).toBe(input.eventId);
    expect(
      verifyWebhookSignature({
        ...input,
        signature: headers["x-hookforge-signature"],
        nowSeconds: input.timestampSeconds + 30,
        toleranceSeconds: 300,
      }),
    ).toBe(true);
    expect(
      verifyWebhookSignature({
        ...input,
        rawBody: `${input.rawBody} `,
        signature: headers["x-hookforge-signature"],
        nowSeconds: input.timestampSeconds + 30,
        toleranceSeconds: 300,
      }),
    ).toBe(false);
  });

  it("rejects signatures outside the timestamp tolerance", () => {
    const headers = buildSignatureHeaders({
      eventId: "event_123",
      timestampSeconds: 1_700_000_000,
      rawBody: "{}",
      secret: "whsec_test_secret",
    });

    expect(
      verifyWebhookSignature({
        secret: "whsec_test_secret",
        timestampSeconds: 1_700_000_000,
        rawBody: "{}",
        signature: headers["x-hookforge-signature"],
        nowSeconds: 1_700_001_000,
        toleranceSeconds: 300,
      }),
    ).toBe(false);
  });
});
