import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { encryptSecret, generateSigningSecret } from "../security/crypto.js";
import {
  createEndpointUrlValidator,
  type EndpointUrlValidator,
} from "../security/url.js";
import type { EndpointRecord, HookForgeStore } from "../store.js";
import { authenticate } from "./auth.js";

const endpointParamsSchema = z.object({
  projectId: z.string().uuid(),
  endpointId: z.string().uuid().optional(),
});
const createEndpointSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().min(1).max(2048),
});
const updateEndpointSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    url: z.string().trim().min(1).max(2048).optional(),
  })
  .refine((value) => value.name !== undefined || value.url !== undefined, {
    message: "At least one endpoint field must be provided",
  });
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
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
  };
}

function endpointNotFound(endpoint: EndpointRecord | null): EndpointRecord {
  if (!endpoint) {
    throw notFound();
  }
  return endpoint;
}

interface RouteOptions {
  config: AppConfig;
  store: HookForgeStore;
  urlValidator?: EndpointUrlValidator;
}

export async function registerEndpointRoutes(
  app: FastifyInstance,
  {
    config,
    store,
    urlValidator = createEndpointUrlValidator({
      allowPrivate: config.ALLOW_PRIVATE_ENDPOINTS,
    }),
  }: RouteOptions,
): Promise<void> {
  app.post("/api/v1/projects/:projectId/endpoints", async (request, reply) => {
    const auth = await authenticate(request, store);
    const params = parse(endpointParamsSchema, request.params);
    if (!(await store.getProject(auth.user.id, params.projectId))) {
      throw notFound();
    }
    const input = parse(createEndpointSchema, request.body);
    const url = await urlValidator.validate(input.url);
    const signingSecret = generateSigningSecret();
    const endpoint = await store.createEndpoint({
      ownerId: auth.user.id,
      projectId: params.projectId,
      name: input.name,
      nameNormalized: input.name.toLocaleLowerCase(),
      url,
      secret: encryptSecret(signingSecret, config.SECRET_ENCRYPTION_KEY),
    });

    return reply.code(201).send({
      endpoint: endpointResponse(endpoint),
      signingSecret,
    });
  });

  app.get("/api/v1/projects/:projectId/endpoints", async (request, reply) => {
    const auth = await authenticate(request, store);
    const params = parse(endpointParamsSchema, request.params);
    if (!(await store.getProject(auth.user.id, params.projectId))) {
      throw notFound();
    }
    const query = parse(listQuerySchema, request.query);
    const endpoints = await store.listEndpoints(
      auth.user.id,
      params.projectId,
      query.limit,
    );
    return reply.send({ endpoints: endpoints.map(endpointResponse) });
  });

  app.get(
    "/api/v1/projects/:projectId/endpoints/:endpointId",
    async (request, reply) => {
      const auth = await authenticate(request, store);
      const params = parse(endpointParamsSchema, request.params);
      const endpoint = endpointNotFound(
        await store.getEndpoint(
          auth.user.id,
          params.projectId,
          params.endpointId!,
        ),
      );
      return reply.send({ endpoint: endpointResponse(endpoint) });
    },
  );

  app.patch(
    "/api/v1/projects/:projectId/endpoints/:endpointId",
    async (request, reply) => {
      const auth = await authenticate(request, store);
      const params = parse(endpointParamsSchema, request.params);
      const input = parse(updateEndpointSchema, request.body);
      const url = input.url
        ? await urlValidator.validate(input.url)
        : undefined;
      try {
        const update: { name?: string; nameNormalized?: string; url?: string } =
          {};
        if (input.name !== undefined) {
          update.name = input.name;
          update.nameNormalized = input.name.toLocaleLowerCase();
        }
        if (url !== undefined) {
          update.url = url;
        }
        const endpoint = endpointNotFound(
          await store.updateEndpoint(
            auth.user.id,
            params.projectId,
            params.endpointId!,
            update,
          ),
        );
        return reply.send({ endpoint: endpointResponse(endpoint) });
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "23505"
        ) {
          throw conflict(
            "ENDPOINT_NAME_TAKEN",
            "This project already has an endpoint with this name",
          );
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/v1/projects/:projectId/endpoints/:endpointId/pause",
    async (request, reply) => {
      return changeStatus(request, reply, store, "paused");
    },
  );
  app.post(
    "/api/v1/projects/:projectId/endpoints/:endpointId/resume",
    async (request, reply) => {
      return changeStatus(request, reply, store, "active");
    },
  );

  app.post(
    "/api/v1/projects/:projectId/endpoints/:endpointId/rotate-secret",
    async (request, reply) => {
      const auth = await authenticate(request, store);
      const params = parse(endpointParamsSchema, request.params);
      const signingSecret = generateSigningSecret();
      const endpoint = endpointNotFound(
        await store.rotateEndpointSecret(
          auth.user.id,
          params.projectId,
          params.endpointId!,
          encryptSecret(signingSecret, config.SECRET_ENCRYPTION_KEY),
        ),
      );
      return reply.send({
        endpoint: endpointResponse(endpoint),
        signingSecret,
      });
    },
  );

  app.delete(
    "/api/v1/projects/:projectId/endpoints/:endpointId",
    async (request, reply) => {
      const auth = await authenticate(request, store);
      const params = parse(endpointParamsSchema, request.params);
      endpointNotFound(
        await store.setEndpointStatus(
          auth.user.id,
          params.projectId,
          params.endpointId!,
          "disabled",
        ),
      );
      return reply.code(204).send();
    },
  );
}

async function changeStatus(
  request: FastifyRequest,
  reply: FastifyReply,
  store: HookForgeStore,
  status: "active" | "paused",
) {
  const auth = await authenticate(request, store);
  const params = parse(endpointParamsSchema, request.params);
  const current = endpointNotFound(
    await store.getEndpoint(auth.user.id, params.projectId, params.endpointId!),
  );
  if (current.status === "disabled") {
    throw conflict(
      "ENDPOINT_DISABLED",
      "Disabled endpoints cannot change status",
    );
  }
  const endpoint = endpointNotFound(
    await store.setEndpointStatus(
      auth.user.id,
      params.projectId,
      params.endpointId!,
      status,
    ),
  );
  return reply.send({ endpoint: endpointResponse(endpoint) });
}
