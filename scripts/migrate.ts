import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { parseConfig } from "../apps/api/src/config.js";

const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "db",
  "migrations",
);

const config = parseConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const client = await pool.connect();

try {
  await client.query(
    "SELECT pg_advisory_lock(hashtextextended('hookforge:migrations', 0))",
  );
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = basename(file, ".sql");
    const existing = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = $1",
      [version],
    );

    if (existing.rowCount !== 0) {
      continue;
    }

    const sql = await readFile(join(migrationsDirectory, file), "utf8");

    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [version],
      );
      await client.query("COMMIT");
      console.info(`Applied migration ${version}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query(
    "SELECT pg_advisory_unlock(hashtextextended('hookforge:migrations', 0))",
  );
  client.release();
  await pool.end();
}
