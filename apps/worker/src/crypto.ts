import { createDecipheriv } from "node:crypto";

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export function decryptSecret(
  encrypted: EncryptedSecret,
  encodedKey: string,
): string {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) {
    throw new Error("Worker encryption key must decode to 32 bytes");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encrypted.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
