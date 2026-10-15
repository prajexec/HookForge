import { describe, expect, it, vi } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  verifyPassword,
} from "../src/security/crypto.js";
import { EnvelopeEncryption } from "../src/security/envelope.js";
import { parseConfig } from "../src/config.js";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("cryptographic boundaries", () => {
  it("hashes passwords and rejects incorrect credentials", async () => {
    const hash = await hashPassword("correct horse battery staple");

    expect(hash).toMatch(/^scrypt\$ln=15,r=8,p=1\$/);
    await expect(
      verifyPassword("correct horse battery staple", hash),
    ).resolves.toBe(true);
    await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
  });

  it("encrypts signing secrets so the stored value is not plaintext", () => {
    const encrypted = encryptSecret("whsec_test_secret", encryptionKey);

    expect(encrypted.ciphertext).not.toContain("whsec_test_secret");
    expect(decryptSecret(encrypted, encryptionKey)).toBe("whsec_test_secret");
  });

  it("creates a Vault-wrapped data-key version for new ciphertext", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith("INSERT INTO encryption_key_versions")) {
          return { rows: [{ version: 1 }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => client),
    } as never;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: { ciphertext: "vault:v1:wrapped" } }),
      })),
    );
    try {
      const config = parseConfig({
        NODE_ENV: "test",
        ENVELOPE_PROVIDER: "vault",
        VAULT_TOKEN: "test-token",
      });
      const encryption = new EnvelopeEncryption(pool, config);
      const encrypted = await encryption.encrypt("whsec_vault_secret");

      expect(encrypted.encryptionKeyVersion).toBe(1);
      expect(encrypted.ciphertext).not.toContain("whsec_vault_secret");
      expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining("encryption.data_key.created"),
        expect.any(Array),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
