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
});

export type AppConfig = z.infer<typeof environmentSchema>;

export function parseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    throw new Error(
      `Invalid environment configuration: ${result.error.message}`,
    );
  }

  return result.data;
}
