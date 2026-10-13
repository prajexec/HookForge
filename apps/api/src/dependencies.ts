import { Pool } from "pg";
import { createClient } from "redis";

import type { AppConfig } from "./config.js";

export interface DatabaseHealthClient {
  query: (text: string) => Promise<unknown>;
}

export interface RedisHealthClient {
  ping: () => Promise<string>;
}

export interface AppDependencies {
  db: DatabaseHealthClient;
  redis: RedisHealthClient;
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
