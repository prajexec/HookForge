import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import { badRequest } from "../errors.js";
import type { Metrics } from "../metrics.js";
import type { HookForgeStore, JsonValue } from "../store.js";
import { authenticate } from "./auth.js";

const eventParamsSchema = z.object({ projectId: z.string().uuid() });
const eventBodySchema = z.object({
  eventType: z.string().trim().min(1).max(100),
  payload: z.unknown(),
});
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
}

export async function registerEventRoutes(
  app: FastifyInstance,
  { config, store, metrics }: RouteOptions,
): Promise<void> {
  app.post("/api/v1/projects/:projectId/events", async (request, reply) => {
    const auth = await authenticate(request, store);
    const params = parse(eventParamsSchema, request.params);
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
