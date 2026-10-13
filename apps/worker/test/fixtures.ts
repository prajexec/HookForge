import { createCipheriv, randomBytes, randomUUID } from "node:crypto";

import type { DeliveryJob } from "../src/delivery-store.js";

export const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export function encryptFixtureSecret(secret: string) {
  const key = Buffer.from(encryptionKey, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  };
}

export function deliveryJob(overrides: Partial<DeliveryJob> = {}): DeliveryJob {
  return {
    id: randomUUID(),
    eventId: randomUUID(),
    eventType: "payment.created",
    payload: { paymentId: "pay_123" },
    endpointId: randomUUID(),
    endpointUrl: "https://93.184.216.34/hook",
    endpointSecretVersion: 1,
    encryptedSecret: encryptFixtureSecret("whsec_test_secret"),
    attemptNumber: 1,
    leaseToken: randomUUID(),
    ...overrides,
  };
}
