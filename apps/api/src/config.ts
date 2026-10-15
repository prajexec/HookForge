import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default(
      "postgresql://hookforge:hookforge_dev_only@localhost:5432/hookforge",
    ),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  CORS_ORIGIN: z.string().min(1).default("http://localhost:5173"),
  RATE_LIMIT_ENABLED: z.enum(["true", "false"]).optional(),
  RATE_LIMIT_MAX_ENTRIES: z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(10_000),
  RATE_LIMIT_AUTH_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(10),
  RATE_LIMIT_AUTH_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(86_400)
    .default(60),
  RATE_LIMIT_EVENT_MAX_REQUESTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(120),
  RATE_LIMIT_EVENT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(86_400)
    .default(60),
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(2_592_000)
    .default(86_400),
  MAX_EVENT_PAYLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(200_000)
    .default(131_072),
  SECRET_ENCRYPTION_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64")
    .refine((value) => Buffer.from(value, "base64").length === 32, {
      message: "must decode to 32 bytes",
    })
    .optional(),
  ALLOW_PRIVATE_ENDPOINTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SANDBOX_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  SANDBOX_RECEIVER_INTERNAL_URL: z
    .string()
    .url()
    .default("http://localhost:8080"),
  SANDBOX_RECEIVER_PUBLIC_URL: z
    .string()
    .url()
    .default("http://localhost:8080"),
});

export type AppConfig = Omit<
  z.infer<typeof environmentSchema>,
  "SECRET_ENCRYPTION_KEY" | "RATE_LIMIT_ENABLED"
> & { SECRET_ENCRYPTION_KEY: string; RATE_LIMIT_ENABLED: boolean };

const localEncryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export function parseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    throw new Error(
      `Invalid environment configuration: ${result.error.message}`,
    );
  }

  if (
    result.data.NODE_ENV === "production" &&
    !result.data.SECRET_ENCRYPTION_KEY
  ) {
    throw new Error(
      "Invalid environment configuration: SECRET_ENCRYPTION_KEY is required in production",
    );
  }
  if (
    result.data.NODE_ENV === "production" &&
    result.data.ALLOW_PRIVATE_ENDPOINTS
  ) {
    throw new Error(
      "Invalid environment configuration: ALLOW_PRIVATE_ENDPOINTS cannot be enabled in production",
    );
  }

  return {
    ...result.data,
    RATE_LIMIT_ENABLED:
      result.data.RATE_LIMIT_ENABLED === undefined
        ? result.data.NODE_ENV !== "test"
        : result.data.RATE_LIMIT_ENABLED === "true",
    SECRET_ENCRYPTION_KEY:
      result.data.SECRET_ENCRYPTION_KEY ?? localEncryptionKey,
  };
}
