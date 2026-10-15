import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import {
  DEFAULT_MAX_REQUESTS_PER_TOKEN,
  DEFAULT_MAX_TOKENS,
  InMemoryRequestStore,
  type SafeHeaders,
} from "./store.js";
import type { CapturedRequest } from "./store.js";

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
]);

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export interface MockReceiverConfig {
  host: string;
  port: number;
  maxBodyBytes: number;
  maxRequestsPerToken: number;
  maxTokens: number;
}

export interface BuildAppOptions {
  config?: Partial<MockReceiverConfig>;
  logger?: FastifyServerOptions["logger"];
  store?: InMemoryRequestStore;
}

interface HookParams {
  token: string;
}

export function buildApp({
  config: configOverrides = {},
  logger,
  store,
}: BuildAppOptions = {}): FastifyInstance {
  const config = {
    ...parseConfig(),
    ...configOverrides,
  };
  const requestStore =
    store ??
    new InMemoryRequestStore({
      maxRequestsPerToken: config.maxRequestsPerToken,
      maxTokens: config.maxTokens,
    });

  const app = Fastify({
    bodyLimit: config.maxBodyBytes,
    logger: logger ?? { level: process.env.LOG_LEVEL ?? "info" },
  });

  // Fastify's built-in JSON parser creates an object and loses the exact
  // payload sent by the delivery worker. Parse every content type as bytes so
  // the receiver can retain the original body text.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) =>
    done(null, body),
  );

  app.get("/health", async (_request, reply) => {
    return reply.send({
      status: "ok",
      service: "hookforge-mock-receiver",
    });
  });

  app.post<{ Params: HookParams }>("/hooks/:token", async (request, reply) => {
    const captured: CapturedRequest = {
      rawBody: rawBodyText(request.body),
      receivedAt: new Date().toISOString(),
      method: request.method,
      headers: safeHeaders(request.headers),
    };
    requestStore.add(request.params.token, captured);
    return reply.code(200).send();
  });

  app.get<{ Params: HookParams }>(
    "/hooks/:token/requests",
    async (request, reply) => {
      return reply.send(requestStore.list(request.params.token));
    },
  );

  app.delete<{ Params: HookParams }>(
    "/hooks/:token/requests",
    async (request, reply) => {
      return reply.send({
        deleted: requestStore.clear(request.params.token),
      });
    },
  );

  return app;
}

export function parseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): MockReceiverConfig {
  return {
    host: environment.MOCK_RECEIVER_HOST ?? environment.HOST ?? "0.0.0.0",
    port: positiveInteger(
      environment.MOCK_RECEIVER_PORT ?? environment.PORT ?? "8080",
      "MOCK_RECEIVER_PORT",
    ),
    maxBodyBytes: positiveInteger(
      environment.MOCK_RECEIVER_MAX_BODY_BYTES ??
        String(DEFAULT_MAX_BODY_BYTES),
      "MOCK_RECEIVER_MAX_BODY_BYTES",
    ),
    maxRequestsPerToken: positiveInteger(
      environment.MOCK_RECEIVER_MAX_REQUESTS ??
        String(DEFAULT_MAX_REQUESTS_PER_TOKEN),
      "MOCK_RECEIVER_MAX_REQUESTS",
    ),
    maxTokens: positiveInteger(
      environment.MOCK_RECEIVER_MAX_TOKENS ?? String(DEFAULT_MAX_TOKENS),
      "MOCK_RECEIVER_MAX_TOKENS",
    ),
  };
}

async function start(): Promise<void> {
  const config = parseConfig();
  const app = buildApp({ config });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "Shutting down mock receiver");
    await app.close();
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT").then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").then(() => process.exit(0));
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error({ err: error }, "Mock receiver startup failed");
    await app.close();
    process.exitCode = 1;
  }
}

function safeHeaders(
  headers: Record<string, string | string[] | undefined>,
): SafeHeaders {
  const result: SafeHeaders = Object.create(null) as SafeHeaders;
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (value === undefined || SENSITIVE_HEADERS.has(normalizedName)) continue;
    result[normalizedName] = Array.isArray(value) ? [...value] : value;
  }
  return result;
}

function rawBodyText(body: unknown): string {
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (typeof body === "string") return body;
  return body === undefined ? "" : String(body);
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  await start();
}
