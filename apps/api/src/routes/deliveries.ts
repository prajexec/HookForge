import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { badRequest, notFound } from "../errors.js";
import type { Metrics } from "../metrics.js";
import type {
  DeliveryCursor,
  DeliveryDetail,
  DeliveryListFilter,
  DeliveryStatus,
  DeliverySummary,
  HookForgeStore,
} from "../store.js";
import { authenticate } from "./auth.js";

const paramsSchema = z.object({
  projectId: z.string().uuid(),
  deliveryId: z.string().uuid().optional(),
});
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(512).optional(),
  status: z.enum(["pending", "in_flight", "delivered", "failed"]).optional(),
  endpointId: z.string().uuid().optional(),
  eventType: z.string().trim().min(1).max(100).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

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

function encodeCursor(cursor: DeliveryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): DeliveryCursor {
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    return parse(
      z.object({
        createdAt: z.string().datetime({ offset: true }),
        id: z.string().uuid(),
      }),
      decoded,
    );
  } catch {
    throw badRequest("INVALID_CURSOR", "Delivery cursor is invalid");
  }
}

function deliveryResponse(delivery: DeliverySummary) {
  return {
    id: delivery.id,
    projectId: delivery.projectId,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    endpoint: {
      id: delivery.endpointId,
      name: delivery.endpointName,
      url: delivery.endpointUrl,
    },
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    nextAttemptAt: delivery.nextAttemptAt,
    lastHttpStatusCode: delivery.lastHttpStatusCode,
    lastError: delivery.lastError,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
    completedAt: delivery.completedAt,
    replayOfDeliveryId: delivery.replayOfDeliveryId,
    replayNumber: delivery.replayNumber,
  };
}

function detailResponse(detail: DeliveryDetail) {
  return {
    delivery: deliveryResponse(detail.delivery),
    eventPayload: detail.eventPayload,
    attempts: detail.attempts,
  };
}

interface RouteOptions {
  store: HookForgeStore;
  metrics: Metrics;
}

export async function registerDeliveryRoutes(
  app: FastifyInstance,
  { store, metrics }: RouteOptions,
): Promise<void> {
  app.get("/api/v1/projects/:projectId/deliveries", async (request, reply) => {
    const auth = await authenticate(request, store);
    const params = parse(paramsSchema, request.params);
    const query = parse(querySchema, request.query);
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const filter: DeliveryListFilter = {
      limit: query.limit,
      ...(query.status ? { status: query.status as DeliveryStatus } : {}),
      ...(query.endpointId ? { endpointId: query.endpointId } : {}),
      ...(query.eventType ? { eventType: query.eventType } : {}),
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
      ...(cursor ? { cursor } : {}),
    };
    const result = await store.listDeliveries(
      auth.user.id,
      params.projectId,
      filter,
    );
    return reply.send({
      deliveries: result.deliveries.map(deliveryResponse),
      pagination: {
        limit: query.limit,
        nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
      },
    });
  });

  app.post(
    "/api/v1/projects/:projectId/deliveries/reconcile",
    async (request, reply) => {
      const auth = await authenticate(request, store);
      const params = parse(paramsSchema, request.params);
      const reconciledCount = await store.reconcileExpiredDeliveries(
        auth.user.id,
        params.projectId,
      );
      metrics.increment("deliveryReconciliationsTotal");
      return reply.send({ reconciledCount });
    },
  );

  app.get(
    "/api/v1/projects/:projectId/deliveries/:deliveryId",
    async (request, reply) => {
      const auth = await authenticate(request, store);
      const params = parse(paramsSchema, request.params);
      const detail = await store.getDelivery(
        auth.user.id,
        params.projectId,
        params.deliveryId!,
      );
      if (!detail) throw notFound();
      return reply.send(detailResponse(detail));
    },
  );

  app.post(
    "/api/v1/projects/:projectId/deliveries/:deliveryId/replay",
    async (request, reply) => {
      const auth = await authenticate(request, store);
      const params = parse(paramsSchema, request.params);
      const replay = await store.replayDelivery(
        auth.user.id,
        params.projectId,
        params.deliveryId!,
      );
      if (!replay) throw notFound();
      metrics.increment("deliveryReplaysTotal");
      return reply.code(202).send({
        delivery: deliveryResponse(replay),
        replayedFromDeliveryId: replay.replayOfDeliveryId,
      });
    },
  );
}
