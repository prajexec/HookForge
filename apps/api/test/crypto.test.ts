import { describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  verifyPassword,
} from "../src/security/crypto.js";

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
});
