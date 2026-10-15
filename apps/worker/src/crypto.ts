import { createDecipheriv } from "node:crypto";

import type { Pool, QueryResultRow } from "pg";

import type { WorkerConfig } from "./config.js";

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  encryptionKeyVersion?: number;
}

export function decryptSecretWithKey(
  encrypted: EncryptedSecret,
  key: Buffer,
): string {
  if (key.length !== 32) {
    throw new Error("Worker encryption key must be 32 bytes");
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

export function decryptSecret(
  encrypted: EncryptedSecret,
  encodedKey: string,
): string {
  const key = Buffer.from(encodedKey, "base64");
  return decryptSecretWithKey(encrypted, key);
}

interface EncryptionKeyRow extends QueryResultRow {
  provider: "vault";
  provider_key_id: string;
  wrapped_data_key: string;
}

interface CachedKey {
  key: Buffer;
  expiresAt: number;
}

/** Resolves versioned envelope keys and keeps only short-lived plaintext DEKs in memory. */
export class EnvelopeKeyResolver {
  private readonly cache = new Map<number, CachedKey>();

  public constructor(
    private readonly pool: Pool,
    private readonly config: WorkerConfig,
  ) {}

  public async resolve(version: number): Promise<Buffer> {
    const cached = this.cache.get(version);
    if (cached && cached.expiresAt > Date.now()) return cached.key;
    if (this.config.ENVELOPE_PROVIDER !== "vault" || !this.config.VAULT_TOKEN) {
      throw new Error(
        `Envelope key version ${version} is unavailable in legacy mode`,
      );
    }
    const result = await this.pool.query<EncryptionKeyRow>(
      `SELECT provider, provider_key_id, wrapped_data_key
         FROM encryption_key_versions
        WHERE version = $1 AND status IN ('active', 'retiring')`,
      [version],
    );
    const row = result.rows[0];
    if (!row || row.provider !== "vault") {
      throw new Error(`Encryption key version ${version} is unavailable`);
    }
    const response = await fetch(
      `${this.config.VAULT_ADDR.replace(/\/$/, "")}/v1/transit/decrypt/${encodeURIComponent(row.provider_key_id)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vault-token": this.config.VAULT_TOKEN,
          ...(this.config.VAULT_NAMESPACE
            ? { "x-vault-namespace": this.config.VAULT_NAMESPACE }
            : {}),
        },
        body: JSON.stringify({ ciphertext: row.wrapped_data_key }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Vault transit decrypt failed with HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as { data?: { plaintext?: string } };
    const key = Buffer.from(body.data?.plaintext ?? "", "base64");
    if (key.length !== 32) {
      throw new Error(`Vault returned an invalid key for version ${version}`);
    }
    this.cache.set(version, {
      key,
      expiresAt:
        Date.now() + this.config.ENVELOPE_KEY_CACHE_TTL_SECONDS * 1_000,
    });
    return key;
  }
}
