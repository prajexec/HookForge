import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { badRequest, notFound } from "../errors.js";
import { authenticate } from "./auth.js";
import type { HookForgeStore } from "../store.js";

const projectSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

const projectParamsSchema = z.object({ projectId: z.string().uuid() });
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

function projectResponse(
  project: Awaited<ReturnType<HookForgeStore["getProject"]>>,
) {
  if (!project) {
    throw notFound();
  }
  return {
    id: project.id,
    publicIdentifier: project.publicIdentifier,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export async function registerProjectRoutes(
  app: FastifyInstance,
  { store }: { store: HookForgeStore },
): Promise<void> {
  app.post("/api/v1/projects", async (request, reply) => {
    const auth = await authenticate(request, store);
    const input = parse(projectSchema, request.body);
    const project = await store.createProject({
      ownerId: auth.user.id,
      name: input.name,
      nameNormalized: input.name.toLocaleLowerCase(),
      publicIdentifier: `hf_proj_${randomUUID().replaceAll("-", "")}`,
    });
    return reply.code(201).send({ project: projectResponse(project) });
  });

  app.get("/api/v1/projects", async (request, reply) => {
    const auth = await authenticate(request, store);
    const query = parse(listQuerySchema, request.query);
    const projects = await store.listProjects(auth.user.id, query.limit);
    return reply.send({
      projects: projects.map((project) => projectResponse(project)),
    });
  });

  app.get("/api/v1/projects/:projectId", async (request, reply) => {
    const auth = await authenticate(request, store);
    const params = parse(projectParamsSchema, request.params);
    const project = await store.getProject(auth.user.id, params.projectId);
    return reply.send({ project: projectResponse(project) });
  });
}
