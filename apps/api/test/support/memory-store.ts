import { randomUUID } from "node:crypto";

import { conflict, notFound } from "../../src/errors.js";
import type {
  EncryptedSecretRecord,
  EndpointRecord,
  EndpointStatus,
  EventRecord,
  HookForgeStore,
  IngestEventResult,
  JsonValue,
  ProjectRecord,
  SessionRecord,
  UserRecord,
} from "../../src/store.js";

function now(): string {
  return new Date().toISOString();
}

export class MemoryStore implements HookForgeStore {
  public readonly secrets = new Map<string, EncryptedSecretRecord[]>();
  public readonly events = new Map<string, EventRecord>();
  public readonly deliveries: Array<{
    eventId: string;
    endpointId: string;
    endpointUrl: string;
    endpointSecretVersion: number;
    status: "pending";
  }> = [];
  private readonly users = new Map<string, UserRecord>();
  private readonly sessions = new Map<
    string,
    { tokenHash: string; record: SessionRecord }
  >();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly endpoints = new Map<string, EndpointRecord>();
  private readonly idempotency = new Map<
    string,
    { requestHash: string; eventId: string }
  >();

  public async createUser(input: {
    email: string;
    emailNormalized: string;
    passwordHash: string;
  }): Promise<UserRecord> {
    if (
      [...this.users.values()].some(
        (user) => user.email === input.emailNormalized,
      )
    ) {
      throw conflict(
        "EMAIL_TAKEN",
        "An account with this email already exists",
      );
    }
    const timestamp = now();
    const user = {
      id: randomUUID(),
      email: input.email,
      passwordHash: input.passwordHash,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.users.set(user.id, user);
    return user;
  }

  public async findUserByEmail(
    emailNormalized: string,
  ): Promise<UserRecord | null> {
    return (
      [...this.users.values()].find((user) => user.email === emailNormalized) ??
      null
    );
  }

  public async createSession(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<{ id: string; expiresAt: string }> {
    const id = randomUUID();
    const expiresAt = input.expiresAt.toISOString();
    const user = this.users.get(input.userId);
    if (!user) {
      throw notFound();
    }
    this.sessions.set(id, {
      tokenHash: input.tokenHash,
      record: {
        id,
        userId: user.id,
        expiresAt,
        revokedAt: null,
        user,
      },
    });
    return { id, expiresAt };
  }

  public async findSessionByTokenHash(
    tokenHash: string,
  ): Promise<SessionRecord | null> {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.tokenHash === tokenHash,
    );
    if (
      !session ||
      session.record.revokedAt ||
      Date.parse(session.record.expiresAt) <= Date.now()
    ) {
      return null;
    }
    return session.record;
  }

  public async revokeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.record.revokedAt = now();
    }
  }

  public async createProject(input: {
    ownerId: string;
    name: string;
    nameNormalized: string;
    publicIdentifier: string;
  }): Promise<ProjectRecord> {
    if (
      [...this.projects.values()].some(
        (project) =>
          project.ownerId === input.ownerId &&
          project.name.toLowerCase() === input.nameNormalized,
      )
    ) {
      throw conflict(
        "PROJECT_NAME_TAKEN",
        "You already have a project with this name",
      );
    }
    const timestamp = now();
    const project = {
      id: randomUUID(),
      ownerId: input.ownerId,
      name: input.name,
      publicIdentifier: input.publicIdentifier,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.projects.set(project.id, project);
    return project;
  }

  public async listProjects(
    ownerId: string,
    limit: number,
  ): Promise<ProjectRecord[]> {
    return [...this.projects.values()]
      .filter((project) => project.ownerId === ownerId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  public async getProject(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectRecord | null> {
    const project = this.projects.get(projectId);
    return project?.ownerId === ownerId ? project : null;
  }

  public async createEndpoint(input: {
    ownerId: string;
    projectId: string;
    name: string;
    nameNormalized: string;
    url: string;
    secret: EncryptedSecretRecord;
  }): Promise<EndpointRecord> {
    const project = await this.getProject(input.ownerId, input.projectId);
    if (!project) {
      throw notFound();
    }
    if (
      [...this.endpoints.values()].some(
        (endpoint) =>
          endpoint.projectId === input.projectId &&
          endpoint.name.toLowerCase() === input.nameNormalized,
      )
    ) {
      throw conflict(
        "ENDPOINT_NAME_TAKEN",
        "This project already has an endpoint with this name",
      );
    }
    const timestamp = now();
    const endpoint = {
      id: randomUUID(),
      projectId: input.projectId,
      name: input.name,
      url: input.url,
      status: "active" as const,
      currentSecretVersion: 1,
      lastSuccessfulDeliveryAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.endpoints.set(endpoint.id, endpoint);
    this.secrets.set(endpoint.id, [input.secret]);
    return endpoint;
  }

  public async listEndpoints(
    ownerId: string,
    projectId: string,
    limit: number,
  ): Promise<EndpointRecord[]> {
    if (!(await this.getProject(ownerId, projectId))) {
      return [];
    }
    return [...this.endpoints.values()]
      .filter((endpoint) => endpoint.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  public async getEndpoint(
    ownerId: string,
    projectId: string,
    endpointId: string,
  ): Promise<EndpointRecord | null> {
    const endpoint = this.endpoints.get(endpointId);
    return endpoint?.projectId === projectId &&
      (await this.getProject(ownerId, projectId))
      ? endpoint
      : null;
  }

  public async updateEndpoint(
    ownerId: string,
    projectId: string,
    endpointId: string,
    input: { name?: string; nameNormalized?: string; url?: string },
  ): Promise<EndpointRecord | null> {
    const endpoint = await this.getEndpoint(ownerId, projectId, endpointId);
    if (!endpoint) {
      return null;
    }
    if (
      input.nameNormalized &&
      [...this.endpoints.values()].some(
        (candidate) =>
          candidate.id !== endpointId &&
          candidate.projectId === projectId &&
          candidate.name.toLowerCase() === input.nameNormalized,
      )
    ) {
      throw conflict(
        "ENDPOINT_NAME_TAKEN",
        "This project already has an endpoint with this name",
      );
    }
    if (input.name) endpoint.name = input.name;
    if (input.url) endpoint.url = input.url;
    endpoint.updatedAt = now();
    return endpoint;
  }

  public async setEndpointStatus(
    ownerId: string,
    projectId: string,
    endpointId: string,
    status: EndpointStatus,
  ): Promise<EndpointRecord | null> {
    const endpoint = await this.getEndpoint(ownerId, projectId, endpointId);
    if (!endpoint) {
      return null;
    }
    endpoint.status = status;
    endpoint.updatedAt = now();
    return endpoint;
  }

  public async rotateEndpointSecret(
    ownerId: string,
    projectId: string,
    endpointId: string,
    secret: EncryptedSecretRecord,
  ): Promise<EndpointRecord | null> {
    const endpoint = await this.getEndpoint(ownerId, projectId, endpointId);
    if (!endpoint) {
      return null;
    }
    if (endpoint.status === "disabled") {
      throw conflict(
        "ENDPOINT_DISABLED",
        "Disabled endpoints cannot rotate signing secrets",
      );
    }
    endpoint.currentSecretVersion += 1;
    endpoint.updatedAt = now();
    this.secrets.set(endpoint.id, [
      ...(this.secrets.get(endpoint.id) ?? []),
      secret,
    ]);
    return endpoint;
  }

  public async ingestEvent(input: {
    ownerId: string;
    projectId: string;
    eventType: string;
    payload: JsonValue;
    idempotencyKey?: string;
    requestHash: string;
  }): Promise<IngestEventResult> {
    if (!(await this.getProject(input.ownerId, input.projectId))) {
      throw notFound();
    }

    const key =
      input.idempotencyKey === undefined
        ? undefined
        : `${input.projectId}:${input.idempotencyKey}`;
    if (key !== undefined) {
      const existing = this.idempotency.get(key);
      if (existing) {
        if (existing.requestHash !== input.requestHash) {
          throw conflict(
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency-Key was already used with a different event",
          );
        }
        const event = this.events.get(existing.eventId)!;
        return {
          event,
          deliveryCount: this.deliveries.filter(
            (delivery) => delivery.eventId === event.id,
          ).length,
          deduplicated: true,
        };
      }
    }

    const event: EventRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      eventType: input.eventType,
      payload: input.payload,
      createdAt: now(),
    };
    this.events.set(event.id, event);
    if (key !== undefined) {
      this.idempotency.set(key, {
        requestHash: input.requestHash,
        eventId: event.id,
      });
    }

    const activeEndpoints = [...this.endpoints.values()].filter(
      (endpoint) =>
        endpoint.projectId === input.projectId && endpoint.status === "active",
    );
    for (const endpoint of activeEndpoints) {
      this.deliveries.push({
        eventId: event.id,
        endpointId: endpoint.id,
        endpointUrl: endpoint.url,
        endpointSecretVersion: endpoint.currentSecretVersion,
        status: "pending",
      });
    }

    return {
      event,
      deliveryCount: activeEndpoints.length,
      deduplicated: false,
    };
  }
}
