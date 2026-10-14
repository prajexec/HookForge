import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import { AppError, badRequest, notFound } from "../errors.js";
import type { Metrics } from "../metrics.js";
import type {
  EventCursor,
  EventSummary,
  HookForgeStore,
  JsonValue,
} from "../store.js";
import { authenticate } from "./auth.js";
import { enforceRateLimit, type RateLimiter } from "../rate-limit.js";

const eventParamsSchema = z.object({ projectId: z.string().uuid() }).strict();
const eventBodySchema = z.object({
  eventType: z.string().trim().min(1).max(100),
  payload: z.unknown(),
});
const eventListQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9]\d{0,2}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .default(25),
    cursor: z.string().min(1).max(512).optional(),
    eventType: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const eventCursorSchema = z
  .object({
    createdAt: z
      .string()
      .datetime({ precision: 6 })
      .refine((value) => !value.startsWith("0000-")),
    id: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, "must contain visible ASCII characters");

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(
      "VALIDATION_ERROR",
      result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    );
  }
  return result.data;
}

function encodeCursor(cursor: EventCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): EventCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error("invalid base64url");
    }
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) {
      throw new Error("non-canonical base64url");
    }
    const decoded = JSON.parse(bytes.toString("utf8")) as unknown;
    return parse(eventCursorSchema, decoded);
  } catch {
    throw badRequest("INVALID_CURSOR", "Event cursor is invalid");
  }
}

function eventListResponse(event: EventSummary) {
  return {
    id: event.id,
    projectId: event.projectId,
    eventType: event.eventType,
    createdAt: event.createdAt,
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`)
    .join(",")}}`;
}

function requestHash(eventType: string, payload: JsonValue): string {
  return createHash("sha256")
    .update(`${eventType}\n${stableJson(payload)}`)
    .digest("hex");
}

function idempotencyKeyFromRequest(request: {
  headers: Record<string, unknown>;
}): string | undefined {
  const header = request.headers["idempotency-key"];
  if (header === undefined) return undefined;
  if (typeof header !== "string") {
    throw badRequest(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be a single value",
    );
  }
  return parse(idempotencyKeySchema, header);
}

interface RouteOptions {
  config: AppConfig;
  store: HookForgeStore;
  metrics: Metrics;
  rateLimiter?: RateLimiter;
}

export async function registerEventRoutes(
  app: FastifyInstance,
  { config, store, metrics, rateLimiter }: RouteOptions,
): Promise<void> {
  app.get("/api/v1/projects/:projectId/events", async (request, reply) => {
    const auth = await authenticate(request, store);
    const params = parse(eventParamsSchema, request.params);
    const query = parse(eventListQuerySchema, request.query);
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const result = await store.listEvents(auth.user.id, params.projectId, {
      limit: query.limit,
      ...(query.eventType ? { eventType: query.eventType } : {}),
      ...(cursor ? { cursor } : {}),
    });
    if (!result) {
      throw notFound();
    }
    return reply.send({
      events: result.events.map(eventListResponse),
      pagination: {
        limit: query.limit,
        nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
      },
    });
  });

  app.post("/api/v1/projects/:projectId/events", async (request, reply) => {
    let auth;
    try {
      auth = await authenticate(request, store);
    } catch (error) {
      if (error instanceof AppError && error.code === "UNAUTHORIZED") {
        enforceEventRateLimit(rateLimiter, config, request.ip);
      }
      throw error;
    }
    const params = parse(eventParamsSchema, request.params);
    enforceEventRateLimit(
      rateLimiter,
      config,
      request.ip,
      auth.user.id,
      params.projectId,
    );
    const body = parse(eventBodySchema, request.body);
    if (!isJsonValue(body.payload)) {
      throw badRequest("INVALID_PAYLOAD", "Event payload must be valid JSON");
    }
    const payloadBytes = Buffer.byteLength(
      JSON.stringify(body.payload),
      "utf8",
    );
    if (payloadBytes > config.MAX_EVENT_PAYLOAD_BYTES) {
      throw badRequest(
        "PAYLOAD_TOO_LARGE",
        `Event payload must be at most ${config.MAX_EVENT_PAYLOAD_BYTES} bytes`,
      );
    }
    const idempotencyKey = idempotencyKeyFromRequest(request);
    const result = await store.ingestEvent({
      ownerId: auth.user.id,
      projectId: params.projectId,
      eventType: body.eventType,
      payload: body.payload,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      requestHash: requestHash(body.eventType, body.payload),
    });

    metrics.increment(
      result.deduplicated ? "eventsDeduplicatedTotal" : "eventsAcceptedTotal",
    );
    if (!result.deduplicated) {
      metrics.increment("deliveriesScheduledTotal", result.deliveryCount);
    }

    return reply.code(result.deduplicated ? 200 : 202).send({
      event: {
        id: result.event.id,
        projectId: result.event.projectId,
        eventType: result.event.eventType,
        createdAt: result.event.createdAt,
      },
      deliveriesScheduled: result.deliveryCount,
      deduplicated: result.deduplicated,
    });
  });
}

function enforceEventRateLimit(
  rateLimiter: RateLimiter | undefined,
  config: AppConfig,
  ip: string,
  userId?: string,
  projectId?: string,
): void {
  if (!rateLimiter) return;
  const key =
    userId !== undefined && projectId !== undefined
      ? `events:user:${userId}:project:${projectId}`
      : `events:ip:${ip || "unknown"}`;
  enforceRateLimit(rateLimiter, key, {
    maxRequests: config.RATE_LIMIT_EVENT_MAX_REQUESTS,
    windowSeconds: config.RATE_LIMIT_EVENT_WINDOW_SECONDS,
  });
}
