import { Pool } from "pg";
import { createClient } from "redis";

import type { AppConfig } from "./config.js";
import { PgStore, type HookForgeStore } from "./store.js";
import {
  EnvelopeEncryption,
  type SecretEncryption,
} from "./security/envelope.js";

export interface DatabaseHealthClient {
  query: (text: string, values?: readonly unknown[]) => Promise<unknown>;
}

export interface RedisHealthClient {
  ping: () => Promise<string>;
}

export interface AppDependencies {
  db: DatabaseHealthClient;
  redis: RedisHealthClient;
  store: HookForgeStore;
  encryption?: SecretEncryption;
  connect: () => Promise<void>;
  close: () => Promise<void>;
}

export function createDependencies(config: AppConfig): AppDependencies {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
  });
  const redis = createClient({ url: config.REDIS_URL });
  const encryption =
    config.ENVELOPE_PROVIDER === "vault"
      ? new EnvelopeEncryption(pool, config)
      : undefined;

  redis.on("error", (error) => {
    // The API's request logger owns structured application logging. This
    // listener prevents an unhandled Redis EventEmitter error before startup.
    console.error("Redis client error", error);
  });

  return {
    db: {
      query: async (text) => {
        await pool.query(text);
      },
    },
    redis: {
      ping: () => redis.ping(),
    },
    store: new PgStore(pool),
    ...(encryption ? { encryption } : {}),
    connect: async () => {
      if (!redis.isOpen) {
        await redis.connect();
      }
    },
    close: async () => {
      await pool.end();
      if (redis.isOpen) {
        await redis.quit();
      }
    },
  };
}
