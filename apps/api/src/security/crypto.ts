import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";

import { badRequest } from "../errors.js";

const PASSWORD_KEY_LENGTH = 64;
const ENCRYPTION_ALGORITHM = "aes-256-gcm";

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      keyLength,
      { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey as Buffer);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await deriveKey(password, salt, PASSWORD_KEY_LENGTH);

  return [
    "scrypt",
    "ln=15,r=8,p=1",
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const [algorithm, parameters, encodedSalt, encodedKey] =
    encodedHash.split("$");
  if (
    algorithm !== "scrypt" ||
    parameters !== "ln=15,r=8,p=1" ||
    !encodedSalt ||
    !encodedKey
  ) {
    return false;
  }

  const salt = Buffer.from(encodedSalt, "base64url");
  const expectedKey = Buffer.from(encodedKey, "base64url");
  const derivedKey = await deriveKey(password, salt, expectedKey.length);

  return (
    derivedKey.length === expectedKey.length &&
    timingSafeEqual(derivedKey, expectedKey)
  );
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateSigningSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function encryptionKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) {
    throw badRequest(
      "INVALID_ENCRYPTION_KEY",
      "SECRET_ENCRYPTION_KEY must decode to 32 bytes",
    );
  }
  return key;
}

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export function encryptSecret(
  secret: string,
  encodedKey: string,
): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    ENCRYPTION_ALGORITHM,
    encryptionKey(encodedKey),
    iv,
  );
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

export function decryptSecret(
  encrypted: EncryptedSecret,
  encodedKey: string,
): string {
  const decipher = createDecipheriv(
    ENCRYPTION_ALGORITHM,
    encryptionKey(encodedKey),
    Buffer.from(encrypted.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
