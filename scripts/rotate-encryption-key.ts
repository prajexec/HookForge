import { randomBytes } from "node:crypto";

import { Pool } from "pg";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://hookforge:hookforge_dev_only@localhost:5432/hookforge";
const vaultAddress = process.env.VAULT_ADDR ?? "http://localhost:8200";
const vaultToken = process.env.VAULT_TOKEN;
const vaultNamespace = process.env.VAULT_NAMESPACE;
const transitKey = process.env.VAULT_TRANSIT_KEY ?? "hookforge-secrets";

if (!vaultToken) {
  throw new Error("VAULT_TOKEN is required to rotate the envelope key");
}

const dataKey = randomBytes(32);
const vaultResponse = await fetch(
  `${vaultAddress.replace(/\/$/, "")}/v1/transit/encrypt/${encodeURIComponent(transitKey)}`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vault-token": vaultToken,
      ...(vaultNamespace ? { "x-vault-namespace": vaultNamespace } : {}),
    },
    body: JSON.stringify({ plaintext: dataKey.toString("base64") }),
  },
);
if (!vaultResponse.ok) {
  throw new Error(
    `Vault transit encrypt failed with HTTP ${vaultResponse.status}`,
  );
}
const vaultBody = (await vaultResponse.json()) as {
  data?: { ciphertext?: string };
};
const wrappedDataKey = vaultBody.data?.ciphertext;
if (!wrappedDataKey) {
  throw new Error("Vault did not return a wrapped data key");
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(
    `UPDATE encryption_key_versions
        SET status = 'retiring'
      WHERE status = 'active'`,
  );
  const result = await client.query<{ version: number }>(
    `INSERT INTO encryption_key_versions
       (version, provider, provider_key_id, wrapped_data_key, status)
     SELECT COALESCE(MAX(version), 0) + 1, 'vault', $1, $2, 'active'
       FROM encryption_key_versions
     RETURNING version`,
    [transitKey, wrappedDataKey],
  );
  await client.query(
    `INSERT INTO audit_events
       (action, actor_type, provider, provider_key_id,
        encryption_key_version, success, metadata)
     VALUES ('encryption.data_key.created', 'system', 'vault', $1, $2, true, $3)`,
    [transitKey, result.rows[0]?.version, { rotation: "manual" }],
  );
  await client.query("COMMIT");
  console.info(
    JSON.stringify({
      message: "encryption_key_rotated",
      version: result.rows[0]?.version,
      provider: "vault",
    }),
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
