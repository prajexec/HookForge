import { createHmac, timingSafeEqual } from "node:crypto";

export function signWebhookBody(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  const signedMessage = `${timestampSeconds}.${rawBody}`;
  return createHmac("sha256", secret).update(signedMessage).digest("hex");
}

export function buildSignatureHeaders(input: {
  eventId: string;
  timestampSeconds: number;
  rawBody: string;
  secret: string;
}): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": "HookForge/0.1",
    "x-hookforge-event-id": input.eventId,
    "x-hookforge-timestamp": String(input.timestampSeconds),
    "x-hookforge-signature": `v1=${signWebhookBody(
      input.secret,
      input.timestampSeconds,
      input.rawBody,
    )}`,
  };
}

export function verifyWebhookSignature(input: {
  secret: string;
  timestampSeconds: number;
  rawBody: string;
  signature: string;
  nowSeconds: number;
  toleranceSeconds: number;
}): boolean {
  if (
    Math.abs(input.nowSeconds - input.timestampSeconds) > input.toleranceSeconds
  ) {
    return false;
  }
  if (!input.signature.startsWith("v1=") || input.signature.length !== 3 + 64) {
    return false;
  }
  const expected = Buffer.from(
    signWebhookBody(input.secret, input.timestampSeconds, input.rawBody),
    "hex",
  );
  const received = Buffer.from(input.signature.slice(3), "hex");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
