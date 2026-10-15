import { randomBytes } from "node:crypto";

import type { Pool, QueryResultRow } from "pg";

import type { AppConfig } from "../config.js";
import type { EncryptedSecretRecord } from "../store.js";
import {
  decryptSecretWithKey,
  encryptSecretWithKey,
  type EncryptedSecret,
} from "./crypto.js";

interface KeyVersionRow extends QueryResultRow {
  version: number;
  provider: "vault";
  provider_key_id: string;
  wrapped_data_key: string;
}

interface CachedKey {
  key: Buffer;
  expiresAt: number;
}

export interface SecretEncryption {
  readonly provider: "legacy" | "vault";
  encrypt(secret: string): Promise<EncryptedSecretRecord>;
}

interface VaultConfig {
  address: string;
  token: string;
  namespace?: string;
  transitKey: string;
}

class VaultTransitClient {
  public constructor(private readonly config: VaultConfig) {}

  public async wrap(
    dataKey: Buffer,
  ): Promise<{ ciphertext: string; keyId: string }> {
    const response = await this.request("encrypt", {
      plaintext: dataKey.toString("base64"),
    });
    if (!response.data?.ciphertext) {
      throw new Error("Vault did not return a wrapped envelope key");
    }
    return {
      ciphertext: response.data.ciphertext,
      keyId: this.config.transitKey,
    };
  }

  public async unwrap(
    ciphertext: string,
    keyId = this.config.transitKey,
  ): Promise<Buffer> {
    const response = await this.request("decrypt", { ciphertext }, keyId);
    const plaintext = String(response.data?.plaintext ?? "");
    const dataKey = Buffer.from(plaintext, "base64");
    if (dataKey.length !== 32) {
      throw new Error("Vault returned an invalid envelope data key");
    }
    return dataKey;
  }

  private async request(
    operation: "encrypt" | "decrypt",
    body: Record<string, string>,
    keyId = this.config.transitKey,
  ): Promise<{ data?: { ciphertext?: string; plaintext?: string } }> {
    const response = await fetch(
      `${this.config.address.replace(/\/$/, "")}/v1/transit/${operation}/${encodeURIComponent(keyId)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vault-token": this.config.token,
          ...(this.config.namespace
            ? { "x-vault-namespace": this.config.namespace }
            : {}),
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Vault transit ${operation} failed with HTTP ${response.status}`,
      );
    }
    return (await response.json()) as {
      data?: { ciphertext?: string; plaintext?: string };
    };
  }
}

export class EnvelopeEncryption implements SecretEncryption {
  public readonly provider = "vault" as const;
  private readonly cache = new Map<number, CachedKey>();
  private readonly vault: VaultTransitClient;

  public constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
  ) {
    if (!config.VAULT_TOKEN) {
      throw new Error("VAULT_TOKEN is required for envelope encryption");
    }
    this.vault = new VaultTransitClient({
      address: config.VAULT_ADDR,
      token: config.VAULT_TOKEN,
      ...(config.VAULT_NAMESPACE ? { namespace: config.VAULT_NAMESPACE } : {}),
      transitKey: config.VAULT_TRANSIT_KEY,
    });
  }

  public async encrypt(secret: string): Promise<EncryptedSecretRecord> {
    const active = await this.activeKey();
    const encrypted = encryptSecretWithKey(secret, active.key);
    return { ...encrypted, encryptionKeyVersion: active.version };
  }

  public async rotate(): Promise<number> {
    const dataKey = randomBytes(32);
    const wrapped = await this.vault.wrap(dataKey);
    const client = await this.pool.connect();
    let result: { rows: Array<{ version: number }> };
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE encryption_key_versions
            SET status = 'retiring'
          WHERE status = 'active'`,
      );
      result = await client.query<{ version: number }>(
        `INSERT INTO encryption_key_versions
           (version, provider, provider_key_id, wrapped_data_key, status)
         SELECT COALESCE(MAX(version), 0) + 1, 'vault', $1, $2, 'active'
           FROM encryption_key_versions
         RETURNING version`,
        [wrapped.keyId, wrapped.ciphertext],
      );
      await client.query(
        `INSERT INTO audit_events
           (action, actor_type, provider, provider_key_id,
            encryption_key_version, success, metadata)
         VALUES ('encryption.data_key.created', 'system', 'vault', $1, $2, true, $3)`,
        [wrapped.keyId, result.rows[0]?.version, { rotation: "automatic" }],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const version = Number(result.rows[0]?.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new Error("Could not create an encryption key version");
    }
    this.cache.set(version, {
      key: dataKey,
      expiresAt:
        Date.now() + this.config.ENVELOPE_KEY_CACHE_TTL_SECONDS * 1_000,
    });
    return version;
  }

  private async activeKey(): Promise<{ version: number; key: Buffer }> {
    const result = await this.pool.query<KeyVersionRow>(
      `SELECT version, provider, provider_key_id, wrapped_data_key
         FROM encryption_key_versions
        WHERE status = 'active'
        ORDER BY version DESC
        LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) {
      const version = await this.rotate();
      return { version, key: (await this.cachedKey(version))! };
    }
    return {
      version: row.version,
      key: (await this.cachedKey(row.version, row))!,
    };
  }

  private async cachedKey(
    version: number,
    row?: KeyVersionRow,
  ): Promise<Buffer | null> {
    const cached = this.cache.get(version);
    if (cached && cached.expiresAt > Date.now()) return cached.key;
    const keyRow =
      row ??
      (
        await this.pool.query<KeyVersionRow>(
          `SELECT version, provider, provider_key_id, wrapped_data_key
             FROM encryption_key_versions WHERE version = $1`,
          [version],
        )
      ).rows[0];
    if (!keyRow || keyRow.provider !== "vault") {
      throw new Error(`Unsupported encryption key version ${version}`);
    }
    const key = await this.vault.unwrap(
      keyRow.wrapped_data_key,
      keyRow.provider_key_id,
    );
    this.cache.set(version, {
      key,
      expiresAt:
        Date.now() + this.config.ENVELOPE_KEY_CACHE_TTL_SECONDS * 1_000,
    });
    return key;
  }
}

export function decryptWithEnvelopeKey(
  encrypted: EncryptedSecret,
  dataKey: Buffer,
): string {
  return decryptSecretWithKey(encrypted, dataKey);
}
