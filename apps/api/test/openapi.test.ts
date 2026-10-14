import { describe, expect, it } from "vitest";

import { openApiDocument } from "../src/openapi.js";

const expectedOperations: Record<string, string[]> = {
  "/health": ["get"],
  "/ready": ["get"],
  "/metrics": ["get"],
  "/openapi.json": ["get"],
  "/api/v1/auth/register": ["post"],
  "/api/v1/auth/login": ["post"],
  "/api/v1/auth/me": ["get"],
  "/api/v1/auth/logout": ["post"],
  "/api/v1/projects": ["get", "post"],
  "/api/v1/projects/{projectId}": ["get"],
  "/api/v1/projects/{projectId}/overview": ["get"],
  "/api/v1/projects/{projectId}/endpoints": ["get", "post"],
  "/api/v1/projects/{projectId}/endpoints/{endpointId}": [
    "delete",
    "get",
    "patch",
  ],
  "/api/v1/projects/{projectId}/endpoints/{endpointId}/pause": ["post"],
  "/api/v1/projects/{projectId}/endpoints/{endpointId}/resume": ["post"],
  "/api/v1/projects/{projectId}/endpoints/{endpointId}/rotate-secret": ["post"],
  "/api/v1/projects/{projectId}/events": ["get", "post"],
  "/api/v1/projects/{projectId}/deliveries": ["get"],
  "/api/v1/projects/{projectId}/deliveries/reconcile": ["post"],
  "/api/v1/projects/{projectId}/deliveries/{deliveryId}": ["get"],
  "/api/v1/projects/{projectId}/deliveries/{deliveryId}/replay": ["post"],
};

describe("OpenAPI contract", () => {
  it("documents every implemented route and operation", () => {
    expect(Object.keys(openApiDocument.paths).sort()).toEqual(
      Object.keys(expectedOperations).sort(),
    );

    for (const [path, methods] of Object.entries(expectedOperations)) {
      expect(Object.keys(openApiDocument.paths[path]!).sort()).toEqual(
        methods.sort(),
      );
    }
  });

  it("marks domain routes as bearer-authenticated and documents safe error behavior", () => {
    const eventPost =
      openApiDocument.paths["/api/v1/projects/{projectId}/events"]?.post;
    const metricsGet = openApiDocument.paths["/metrics"]?.get;

    expect(eventPost?.security).toEqual([{ bearerAuth: [] }]);
    expect(eventPost?.responses["202"]).toBeDefined();
    expect(eventPost?.responses["200"]).toBeDefined();
    expect(eventPost?.responses["409"]).toBeDefined();
    expect(eventPost?.responses["429"]?.headers?.["Retry-After"]).toBeDefined();
    expect(eventPost?.responses["500"]).toBeDefined();
    expect(metricsGet?.responses["200"]).toBeDefined();
    expect(JSON.stringify(openApiDocument)).not.toContain("DATABASE_URL");
    expect(JSON.stringify(openApiDocument)).not.toContain(
      "SECRET_ENCRYPTION_KEY",
    );
  });
});
