import { randomUUID } from "node:crypto";

import { conflict, notFound } from "../../src/errors.js";
import type {
  EncryptedSecretRecord,
  EndpointRecord,
  EndpointStatus,
  DeliveryAttemptRecord,
  DeliveryDetail,
  EventListFilter,
  EventListResult,
  EventSummary,
  DeliveryListFilter,
  DeliveryListResult,
  DeliverySummary,
  EventRecord,
  HookForgeStore,
  IngestEventResult,
  JsonValue,
  ProjectRecord,
  ProjectOverview,
  SessionRecord,
  UserRecord,
} from "../../src/store.js";

function now(): string {
  return new Date().toISOString();
}

function eventTimestamp(value: string): string {
  // Match the production cursor's fixed-width UTC representation without
  // losing sub-millisecond digits through Date.
  return value.replace(
    /\.(\d{3,6})Z$/,
    (_match, fraction: string) => `.${fraction.padEnd(6, "0")}Z`,
  );
}

export class MemoryStore implements HookForgeStore {
  public readonly secrets = new Map<string, EncryptedSecretRecord[]>();
  public readonly events = new Map<string, EventRecord>();
  public readonly deliveries: DeliverySummary[] = [];
  public readonly attempts = new Map<string, DeliveryAttemptRecord[]>();
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

  public async getProjectOverview(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectOverview | null> {
    if (!(await this.getProject(ownerId, projectId))) {
      return null;
    }
    const endpoints = [...this.endpoints.values()].filter(
      (endpoint) => endpoint.projectId === projectId,
    );
    const deliveries = this.deliveries.filter(
      (delivery) => delivery.projectId === projectId,
    );
    return {
      events: [...this.events.values()].filter(
        (event) => event.projectId === projectId,
      ).length,
      endpoints: {
        active: endpoints.filter((endpoint) => endpoint.status === "active")
          .length,
        paused: endpoints.filter((endpoint) => endpoint.status === "paused")
          .length,
        disabled: endpoints.filter((endpoint) => endpoint.status === "disabled")
          .length,
      },
      deliveries: {
        pending: deliveries.filter((delivery) => delivery.status === "pending")
          .length,
        in_flight: deliveries.filter(
          (delivery) => delivery.status === "in_flight",
        ).length,
        delivered: deliveries.filter(
          (delivery) => delivery.status === "delivered",
        ).length,
        failed: deliveries.filter((delivery) => delivery.status === "failed")
          .length,
      },
    };
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
        id: randomUUID(),
        projectId: input.projectId,
        eventId: event.id,
        eventType: event.eventType,
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        endpointUrl: endpoint.url,
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: now(),
        lastHttpStatusCode: null,
        lastError: null,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        completedAt: null,
        replayOfDeliveryId: null,
        replayNumber: 0,
      });
    }

    return {
      event,
      deliveryCount: activeEndpoints.length,
      deduplicated: false,
    };
  }

  public async listEvents(
    ownerId: string,
    projectId: string,
    filter: EventListFilter,
  ): Promise<EventListResult | null> {
    if (!(await this.getProject(ownerId, projectId))) {
      return null;
    }
    const filtered = [...this.events.values()]
      .filter((event) => {
        if (event.projectId !== projectId) return false;
        if (filter.eventType && event.eventType !== filter.eventType)
          return false;
        if (filter.cursor) {
          const createdAt = eventTimestamp(event.createdAt);
          const afterCursor =
            createdAt < filter.cursor.createdAt ||
            (createdAt === filter.cursor.createdAt &&
              event.id < filter.cursor.id);
          if (!afterCursor) return false;
        }
        return true;
      })
      .sort(
        (left, right) =>
          eventTimestamp(right.createdAt).localeCompare(
            eventTimestamp(left.createdAt),
          ) || right.id.localeCompare(left.id),
      );
    const hasMore = filtered.length > filter.limit;
    const events = hasMore ? filtered.slice(0, filter.limit) : filtered;
    const last = events.at(-1);
    return {
      events: events.map((event): EventSummary => ({
        id: event.id,
        projectId: event.projectId,
        eventType: event.eventType,
        createdAt: event.createdAt,
      })),
      nextCursor:
        hasMore && last
          ? { createdAt: eventTimestamp(last.createdAt), id: last.id }
          : null,
    };
  }

  public async listDeliveries(
    ownerId: string,
    projectId: string,
    filter: DeliveryListFilter,
  ): Promise<DeliveryListResult> {
    if (!(await this.getProject(ownerId, projectId))) {
      return { deliveries: [], nextCursor: null };
    }
    const filtered = this.deliveries
      .filter((delivery) => {
        if (delivery.projectId !== projectId) return false;
        if (filter.status && delivery.status !== filter.status) return false;
        if (filter.endpointId && delivery.endpointId !== filter.endpointId)
          return false;
        if (filter.eventType && delivery.eventType !== filter.eventType)
          return false;
        if (
          filter.from &&
          Date.parse(delivery.createdAt) < filter.from.getTime()
        )
          return false;
        if (filter.to && Date.parse(delivery.createdAt) >= filter.to.getTime())
          return false;
        if (filter.cursor) {
          const afterCursor =
            delivery.createdAt < filter.cursor.createdAt ||
            (delivery.createdAt === filter.cursor.createdAt &&
              delivery.id < filter.cursor.id);
          if (!afterCursor) return false;
        }
        return true;
      })
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id),
      );
    const hasMore = filtered.length > filter.limit;
    const deliveries = hasMore ? filtered.slice(0, filter.limit) : filtered;
    const last = deliveries.at(-1);
    return {
      deliveries,
      nextCursor:
        hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }

  public async getDelivery(
    ownerId: string,
    projectId: string,
    deliveryId: string,
  ): Promise<DeliveryDetail | null> {
    if (!(await this.getProject(ownerId, projectId))) return null;
    const delivery = this.deliveries.find(
      (candidate) =>
        candidate.id === deliveryId && candidate.projectId === projectId,
    );
    if (!delivery) return null;
    const event = this.events.get(delivery.eventId);
    if (!event) return null;
    return {
      delivery,
      eventPayload: event.payload,
      attempts: this.attempts.get(delivery.id) ?? [],
    };
  }

  public async replayDelivery(
    ownerId: string,
    projectId: string,
    deliveryId: string,
  ): Promise<DeliverySummary | null> {
    if (!(await this.getProject(ownerId, projectId))) return null;
    const source = this.deliveries.find(
      (candidate) =>
        candidate.id === deliveryId && candidate.projectId === projectId,
    );
    if (!source) return null;
    if (source.status !== "failed") {
      throw conflict(
        "DELIVERY_NOT_FAILED",
        "Only terminally failed deliveries can be replayed",
      );
    }
    const endpoint = this.endpoints.get(source.endpointId);
    if (!endpoint || endpoint.status !== "active") {
      throw conflict(
        "ENDPOINT_NOT_ACTIVE",
        "The endpoint must be active before a delivery can be replayed",
      );
    }
    const event = this.events.get(source.eventId)!;
    const replayNumber =
      Math.max(
        ...this.deliveries
          .filter(
            (candidate) =>
              candidate.eventId === source.eventId &&
              candidate.endpointId === source.endpointId,
          )
          .map((candidate) => candidate.replayNumber),
      ) + 1;
    const replay: DeliverySummary = {
      id: randomUUID(),
      projectId,
      eventId: source.eventId,
      eventType: event.eventType,
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      endpointUrl: endpoint.url,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: now(),
      lastHttpStatusCode: null,
      lastError: null,
      createdAt: now(),
      updatedAt: now(),
      completedAt: null,
      replayOfDeliveryId: source.id,
      replayNumber,
    };
    this.deliveries.push(replay);
    return replay;
  }

  public async reconcileExpiredDeliveries(
    ownerId: string,
    projectId: string,
  ): Promise<number> {
    if (!(await this.getProject(ownerId, projectId))) return 0;
    return 0;
  }
}
