import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import { badRequest, unauthorized } from "../errors.js";
import {
  generateSessionToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from "../security/crypto.js";
import type { HookForgeStore, UserRecord } from "../store.js";

const credentialsSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(12).max(128),
});

export interface AuthenticatedRequest extends FastifyRequest {
  auth: {
    sessionId: string;
    user: UserRecord;
  };
}

interface RouteOptions {
  config: AppConfig;
  store: HookForgeStore;
}

function validationError(error: z.ZodError): never {
  throw badRequest(
    "VALIDATION_ERROR",
    error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; "),
  );
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function publicUser(user: UserRecord): {
  id: string;
  email: string;
  createdAt: string;
} {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw unauthorized();
  }
  const token = header.slice("Bearer ".length).trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    throw unauthorized();
  }
  return token;
}

export async function authenticate(
  request: FastifyRequest,
  store: HookForgeStore,
): Promise<AuthenticatedRequest["auth"]> {
  const token = bearerToken(request);
  const session = await store.findSessionByTokenHash(hashToken(token));
  if (!session) {
    throw unauthorized("Invalid or expired session");
  }
  return { sessionId: session.id, user: session.user };
}

function parseCredentials(body: unknown): z.infer<typeof credentialsSchema> {
  const parsed = credentialsSchema.safeParse(body);
  if (!parsed.success) {
    validationError(parsed.error);
  }
  return parsed.data;
}

async function issueSession(
  user: UserRecord,
  config: AppConfig,
  store: HookForgeStore,
): Promise<{ token: string; expiresAt: string }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_SECONDS * 1_000);
  const session = await store.createSession({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, expiresAt: session.expiresAt };
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  { config, store }: RouteOptions,
): Promise<void> {
  app.post("/api/v1/auth/register", async (request, reply) => {
    const credentials = parseCredentials(request.body);
    const email = normalizeEmail(credentials.email);
    const user = await store.createUser({
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(credentials.password),
    });
    const session = await issueSession(user, config, store);

    return reply.code(201).send({
      user: publicUser(user),
      token: session.token,
      expiresAt: session.expiresAt,
    });
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const credentials = parseCredentials(request.body);
    const user = await store.findUserByEmail(normalizeEmail(credentials.email));
    if (
      !user ||
      !(await verifyPassword(credentials.password, user.passwordHash))
    ) {
      throw unauthorized("Invalid email or password");
    }
    const session = await issueSession(user, config, store);

    return reply.send({
      user: publicUser(user),
      token: session.token,
      expiresAt: session.expiresAt,
    });
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    const auth = await authenticate(request, store);
    return reply.send({ user: publicUser(auth.user) });
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const auth = await authenticate(request, store);
    await store.revokeSession(auth.sessionId);
    return reply.code(204).send();
  });
}
