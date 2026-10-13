export interface User {
  id: string;
  email: string;
  createdAt: string;
}

export interface Session {
  user: User;
  token: string;
  expiresAt: string;
}

export interface Project {
  id: string;
  name: string;
  publicIdentifier: string;
  createdAt: string;
  updatedAt: string;
}

export interface Endpoint {
  id: string;
  projectId: string;
  name: string;
  url: string;
  status: "active" | "paused" | "disabled";
  createdAt: string;
  updatedAt: string;
  lastSuccessfulDeliveryAt: string | null;
}

export type DeliveryStatus = "pending" | "in_flight" | "delivered" | "failed";

export interface Delivery {
  id: string;
  projectId: string;
  eventId: string;
  eventType: string;
  endpoint: { id: string; name: string; url: string };
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string;
  lastHttpStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  replayOfDeliveryId: string | null;
  replayNumber: number;
}

export interface DeliveryAttempt {
  id: string;
  attemptNumber: number;
  requestAt: string;
  responseAt: string | null;
  httpStatusCode: number | null;
  responseDurationMs: number | null;
  responseExcerpt: string | null;
  errorClassification: string | null;
  outcome: "success" | "retry" | "failed";
}

export interface DeliveryDetail {
  delivery: Delivery;
  eventPayload: unknown;
  attempts: DeliveryAttempt[];
}

export interface EventSummary {
  id: string;
  projectId: string;
  eventType: string;
  createdAt: string;
}

export interface Pagination {
  limit: number;
  nextCursor: string | null;
}

export interface Overview {
  events: number;
  endpoints: { active: number; paused: number; disabled: number };
  deliveries: Record<DeliveryStatus, number>;
}
