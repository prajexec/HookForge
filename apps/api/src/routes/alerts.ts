import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { badRequest, notFound } from "../errors.js";
import type { HookForgeStore } from "../store.js";
import { authenticate } from "./auth.js";

const paramsSchema = z.object({ projectId: z.string().uuid() });
const bodySchema = z.object({ endpointId: z.string().uuid() }).strict();

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

interface RouteOptions {
  store: HookForgeStore;
}

export async function registerAlertRoutes(
  app: FastifyInstance,
  { store }: RouteOptions,
): Promise<void> {
  app.get(
    "/api/v1/projects/:projectId/alerts/dead-letter",
    async (request, reply) => {
      const auth = await authenticate(request, store);
      const params = parse(paramsSchema, request.params);
      if (!(await store.getProject(auth.user.id, params.projectId))) {
        throw notFound();
      }
      return reply.send({
        alert: await store.getDeadLetterAlert(auth.user.id, params.projectId),
      });
    },
  );

  app.put(
    "/api/v1/projects/:projectId/alerts/dead-letter",
    async (request, reply) => {
      const auth = await authenticate(request, store);
      const params = parse(paramsSchema, request.params);
      const input = parse(bodySchema, request.body);
      const alert = await store.setDeadLetterAlert({
        ownerId: auth.user.id,
        projectId: params.projectId,
        endpointId: input.endpointId,
      });
      if (!alert) throw notFound();
      return reply.send({ alert });
    },
  );

  app.delete(
    "/api/v1/projects/:projectId/alerts/dead-letter",
    async (request, reply) => {
      const auth = await authenticate(request, store);
      const params = parse(paramsSchema, request.params);
      if (!(await store.getProject(auth.user.id, params.projectId))) {
        throw notFound();
      }
      await store.clearDeadLetterAlert(auth.user.id, params.projectId);
      return reply.code(204).send();
    },
  );
}
