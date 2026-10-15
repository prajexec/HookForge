import { randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { encryptSecret, generateSigningSecret } from "../security/crypto.js";
import type { EndpointRecord, HookForgeStore } from "../store.js";
import { authenticate } from "./auth.js";

const projectParamsSchema = z.object({ projectId: z.string().uuid() });
const endpointParamsSchema = projectParamsSchema.extend({
  endpointId: z.string().uuid(),
});
const createSchema = z
  .object({ name: z.string().trim().min(1).max(120).default("Local sandbox") })
  .strict();
const requestsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
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

function endpointResponse(endpoint: EndpointRecord) {
  return {
    id: endpoint.id,
    projectId: endpoint.projectId,
    name: endpoint.name,
    url: endpoint.url,
    status: endpoint.status,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
    lastSuccessfulDeliveryAt: endpoint.lastSuccessfulDeliveryAt,
    eventPatterns: endpoint.eventPatterns,
    staticHeaderNames: endpoint.staticHeaderNames,
  };
}

function sandboxToken(endpoint: EndpointRecord, internalBase: string): string {
  const prefix = `${internalBase}/hooks/`;
  if (!endpoint.url.startsWith(prefix)) {
    throw conflict(
      "NOT_SANDBOX_ENDPOINT",
      "This endpoint is not a local sandbox",
    );
  }
  const token = endpoint.url.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token) || token.includes("/")) {
    throw conflict(
      "NOT_SANDBOX_ENDPOINT",
      "This endpoint is not a local sandbox",
    );
  }
  return token;
}

async function receiverRequest(
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(2_000),
      redirect: "error",
    });
  } catch {
    throw new Error("The local sandbox receiver is unavailable");
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error("The local sandbox receiver rejected the request");
  }
  return body;
}

interface RouteOptions {
  config: AppConfig;
  store: HookForgeStore;
}

export async function registerSandboxRoutes(
  app: FastifyInstance,
  { config, store }: RouteOptions,
): Promise<void> {
  app.post(
    "/api/v1/projects/:projectId/sandbox/endpoints",
    async (request, reply) => {
      if (!config.SANDBOX_ENABLED) {
        throw notFound();
      }
      const auth = await authenticate(request, store);
      const params = parse(projectParamsSchema, request.params);
      if (!(await store.getProject(auth.user.id, params.projectId))) {
        throw notFound();
      }
      const input = parse(createSchema, request.body ?? {});
      const token = randomBytes(24).toString("base64url");
      const internalBase = config.SANDBOX_RECEIVER_INTERNAL_URL.replace(
        /\/$/,
        "",
      );
      const publicBase = config.SANDBOX_RECEIVER_PUBLIC_URL.replace(/\/$/, "");
      const signingSecret = generateSigningSecret();
      const endpoint = await store.createEndpoint({
        ownerId: auth.user.id,
        projectId: params.projectId,
        name: input.name,
        nameNormalized: input.name.toLocaleLowerCase(),
        url: `${internalBase}/hooks/${token}`,
        secret: encryptSecret(signingSecret, config.SECRET_ENCRYPTION_KEY),
        staticHeaders: {},
        eventPatterns: ["*"],
      });
      return reply.code(201).send({
        endpoint: endpointResponse(endpoint),
        signingSecret,
        sandbox: { publicUrl: `${publicBase}/hooks/${token}` },
      });
    },
  );

  app.get(
    "/api/v1/projects/:projectId/endpoints/:endpointId/sandbox/requests",
    async (request, reply) => {
      if (!config.SANDBOX_ENABLED) throw notFound();
      const auth = await authenticate(request, store);
      const params = parse(endpointParamsSchema, request.params);
      const query = parse(requestsQuerySchema, request.query);
      const endpoint = await store.getEndpoint(
        auth.user.id,
        params.projectId,
        params.endpointId,
      );
      if (!endpoint) throw notFound();
      const token = sandboxToken(
        endpoint,
        config.SANDBOX_RECEIVER_INTERNAL_URL.replace(/\/$/, ""),
      );
      const result = await receiverRequest(
        `${config.SANDBOX_RECEIVER_INTERNAL_URL.replace(/\/$/, "")}/hooks/${token}/requests?limit=${query.limit}`,
      );
      return reply.send({ requests: result });
    },
  );

  app.delete(
    "/api/v1/projects/:projectId/endpoints/:endpointId/sandbox/requests",
    async (request, reply) => {
      if (!config.SANDBOX_ENABLED) throw notFound();
      const auth = await authenticate(request, store);
      const params = parse(endpointParamsSchema, request.params);
      const endpoint = await store.getEndpoint(
        auth.user.id,
        params.projectId,
        params.endpointId,
      );
      if (!endpoint) throw notFound();
      const token = sandboxToken(
        endpoint,
        config.SANDBOX_RECEIVER_INTERNAL_URL.replace(/\/$/, ""),
      );
      await receiverRequest(
        `${config.SANDBOX_RECEIVER_INTERNAL_URL.replace(/\/$/, "")}/hooks/${token}/requests`,
        { method: "DELETE" },
      );
      return reply.code(204).send();
    },
  );
}
