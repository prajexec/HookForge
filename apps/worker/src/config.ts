import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default(
      "postgresql://hookforge:hookforge_dev_only@localhost:5432/hookforge",
    ),
  WORKER_METRICS_HOST: z.string().min(1).default("127.0.0.1"),
  WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9464),
  SECRET_ENCRYPTION_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64")
    .refine((value) => Buffer.from(value, "base64").length === 32, {
      message: "must decode to 32 bytes",
    })
    .optional(),
  ENVELOPE_PROVIDER: z.enum(["legacy", "vault"]).default("legacy"),
  ENVELOPE_KEY_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(86_400)
    .default(300),
  VAULT_ADDR: z.string().url().default("http://localhost:8200"),
  VAULT_NAMESPACE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
  VAULT_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  VAULT_TRANSIT_KEY: z.string().trim().min(1).default("hookforge-secrets"),
  ALLOW_PRIVATE_ENDPOINTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  WORKER_ID: z.string().trim().min(1).max(128).default("worker-1"),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(30_000)
    .default(5_000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  WORKER_MAX_IN_FLIGHT_PER_ENDPOINT: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(1),
  WORKER_MAX_IN_FLIGHT_PER_PROJECT: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(5),
  WORKER_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(25)
    .max(10_000)
    .default(250),
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
  WORKER_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(120_000)
    .default(10_000),
  MAX_DELIVERY_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
  RETRY_INITIAL_DELAY_MS: z.coerce
    .number()
    .int()
    .min(10)
    .max(3_600_000)
    .default(1_000),
  RETRY_MAX_DELAY_MS: z.coerce
    .number()
    .int()
    .min(10)
    .max(86_400_000)
    .default(3_600_000),
  RETRY_JITTER_RATIO: z.coerce.number().min(0).max(1).default(0.2),
  MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(256)
    .max(1_000_000)
    .default(8_192),
});

export type WorkerConfig = Omit<
  z.infer<typeof environmentSchema>,
  "SECRET_ENCRYPTION_KEY"
> & {
  SECRET_ENCRYPTION_KEY: string;
  LEGACY_ENCRYPTION_KEY_CONFIGURED: boolean;
};

const localEncryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export function parseWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(`Invalid worker configuration: ${result.error.message}`);
  }
  if (
    result.data.NODE_ENV === "production" &&
    result.data.ENVELOPE_PROVIDER === "legacy" &&
    !result.data.SECRET_ENCRYPTION_KEY
  ) {
    throw new Error(
      "Invalid worker configuration: SECRET_ENCRYPTION_KEY is required in production when ENVELOPE_PROVIDER=legacy",
    );
  }
  if (
    result.data.NODE_ENV === "production" &&
    result.data.ENVELOPE_PROVIDER === "vault" &&
    (!result.data.VAULT_TOKEN || !result.data.VAULT_TRANSIT_KEY)
  ) {
    throw new Error(
      "Invalid worker configuration: VAULT_TOKEN and VAULT_TRANSIT_KEY are required in production when ENVELOPE_PROVIDER=vault",
    );
  }
  if (
    result.data.NODE_ENV === "production" &&
    result.data.ALLOW_PRIVATE_ENDPOINTS
  ) {
    throw new Error(
      "Invalid worker configuration: ALLOW_PRIVATE_ENDPOINTS cannot be enabled in production",
    );
  }
  if (result.data.RETRY_INITIAL_DELAY_MS > result.data.RETRY_MAX_DELAY_MS) {
    throw new Error(
      "Invalid worker configuration: RETRY_INITIAL_DELAY_MS cannot exceed RETRY_MAX_DELAY_MS",
    );
  }
  if (
    result.data.WORKER_LEASE_SECONDS * 1_000 <=
    result.data.WORKER_REQUEST_TIMEOUT_MS + 1_000
  ) {
    throw new Error(
      "Invalid worker configuration: WORKER_LEASE_SECONDS must exceed the request timeout",
    );
  }
  return {
    ...result.data,
    LEGACY_ENCRYPTION_KEY_CONFIGURED:
      result.data.SECRET_ENCRYPTION_KEY !== undefined,
    SECRET_ENCRYPTION_KEY:
      result.data.SECRET_ENCRYPTION_KEY ?? localEncryptionKey,
  };
}
