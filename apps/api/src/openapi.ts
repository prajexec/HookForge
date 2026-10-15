type Schema = Record<string, unknown>;

type ResponseObject = {
  description: string;
  headers?: Record<string, Schema>;
  content?: Record<string, { schema: Schema; example?: unknown }>;
};

type OperationObject = {
  summary: string;
  operationId: string;
  tags: string[];
  security?: Array<Record<string, string[]>>;
  parameters?: Schema[];
  requestBody?: Schema;
  responses: Record<string, ResponseObject>;
};

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string; description: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, OperationObject>>;
  components: {
    securitySchemes: Record<string, Schema>;
    schemas: Record<string, Schema>;
  };
}

const ref = (name: string): Schema => ({
  $ref: `#/components/schemas/${name}`,
});

const json = (schema: Schema, example?: unknown) => ({
  "application/json": {
    schema,
    ...(example === undefined ? {} : { example }),
  },
});

function response(
  description: string,
  schema?: Schema,
  example?: unknown,
): ResponseObject {
  return {
    description,
    ...(schema ? { content: json(schema, example) } : {}),
  };
}

function errorResponse(
  description = "The request failed",
  retryAfter = false,
): ResponseObject {
  return {
    description,
    ...(retryAfter
      ? {
          headers: {
            "Retry-After": {
              description: "Seconds until the client may retry",
              schema: { type: "integer", minimum: 1 },
            },
          },
        }
      : {}),
    content: json(ref("ErrorResponse")),
  };
}

function pathParameter(name: string, description: string): Schema {
  return {
    name,
    in: "path",
    required: true,
    description,
    schema: { type: "string", format: "uuid" },
  };
}

function queryParameter(
  name: string,
  schema: Schema,
  description: string,
): Schema {
  return {
    name,
    in: "query",
    required: false,
    description,
    schema,
  };
}

function jsonRequest(schema: Schema, description: string): Schema {
  return {
    required: true,
    description,
    content: json(schema),
  };
}

const bearerSecurity = [{ bearerAuth: [] }];

const uuid = { type: "string", format: "uuid" };
const timestamp = { type: "string", format: "date-time" };
const nullableTimestamp = { type: ["string", "null"], format: "date-time" };
const jsonValue: Schema = {
  description: "A JSON value. Objects and arrays may be nested.",
  type: ["object", "array", "string", "number", "boolean", "null"],
};

const projectParameters = [pathParameter("projectId", "Owned project UUID")];
const endpointParameters = [
  pathParameter("projectId", "Owned project UUID"),
  pathParameter("endpointId", "Endpoint UUID"),
];
const deliveryParameters = [
  pathParameter("projectId", "Owned project UUID"),
  pathParameter("deliveryId", "Delivery UUID"),
];

const paginationParameters = [
  queryParameter(
    "limit",
    { type: "integer", minimum: 1, maximum: 100, default: 25 },
    "Maximum number of records to return",
  ),
  queryParameter(
    "cursor",
    { type: "string", minLength: 1, maxLength: 512 },
    "Opaque cursor returned by the previous page",
  ),
];

const schemas: Record<string, Schema> = {
  ErrorResponse: {
    type: "object",
    additionalProperties: false,
    required: ["error", "requestId"],
    properties: {
      error: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message"],
        properties: {
          code: { type: "string", example: "VALIDATION_ERROR" },
          message: { type: "string", example: "Request validation failed" },
        },
      },
      requestId: { type: "string", example: "req_01JEXAMPLE" },
    },
  },
  User: {
    type: "object",
    additionalProperties: false,
    required: ["id", "email", "createdAt"],
    properties: {
      id: uuid,
      email: { type: "string", format: "email", maxLength: 320 },
      createdAt: timestamp,
    },
  },
  AuthSession: {
    type: "object",
    additionalProperties: false,
    required: ["user", "token", "expiresAt"],
    properties: {
      user: ref("User"),
      token: {
        type: "string",
        description:
          "Opaque bearer token. Store it securely; it is returned once.",
      },
      expiresAt: timestamp,
    },
  },
  Project: {
    type: "object",
    additionalProperties: false,
    required: ["id", "publicIdentifier", "name", "createdAt", "updatedAt"],
    properties: {
      id: uuid,
      publicIdentifier: {
        type: "string",
        example: "hf_proj_01JEXAMPLE",
      },
      name: { type: "string", minLength: 1, maxLength: 120 },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  },
  Endpoint: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "projectId",
      "name",
      "url",
      "status",
      "createdAt",
      "updatedAt",
      "lastSuccessfulDeliveryAt",
      "eventPatterns",
      "staticHeaderNames",
    ],
    properties: {
      id: uuid,
      projectId: uuid,
      name: { type: "string", minLength: 1, maxLength: 120 },
      url: { type: "string", format: "uri", maxLength: 2048 },
      status: { type: "string", enum: ["active", "paused", "disabled"] },
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSuccessfulDeliveryAt: nullableTimestamp,
      eventPatterns: { type: "array", items: { type: "string" } },
      staticHeaderNames: { type: "array", items: { type: "string" } },
    },
  },
  EventSummary: {
    type: "object",
    additionalProperties: false,
    required: ["id", "projectId", "eventType", "createdAt"],
    properties: {
      id: uuid,
      projectId: uuid,
      eventType: { type: "string", minLength: 1, maxLength: 100 },
      createdAt: timestamp,
    },
  },
  DeliverySummary: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "projectId",
      "eventId",
      "eventType",
      "endpoint",
      "status",
      "attemptCount",
      "nextAttemptAt",
      "lastHttpStatusCode",
      "lastError",
      "createdAt",
      "updatedAt",
      "completedAt",
      "replayOfDeliveryId",
      "replayNumber",
      "deliveryKind",
      "cancelledAt",
      "deadLetteredAt",
      "deadLetterReason",
    ],
    properties: {
      id: uuid,
      projectId: uuid,
      eventId: uuid,
      eventType: { type: "string" },
      endpoint: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "url"],
        properties: {
          id: uuid,
          name: { type: "string" },
          url: { type: "string", format: "uri" },
        },
      },
      status: {
        type: "string",
        enum: ["pending", "in_flight", "delivered", "failed", "cancelled"],
      },
      attemptCount: { type: "integer", minimum: 0 },
      nextAttemptAt: timestamp,
      lastHttpStatusCode: {
        type: ["integer", "null"],
        minimum: 100,
        maximum: 599,
      },
      lastError: { type: ["string", "null"] },
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: nullableTimestamp,
      replayOfDeliveryId: { type: ["string", "null"], format: "uuid" },
      replayNumber: { type: "integer", minimum: 0 },
      deliveryKind: { type: "string", enum: ["event", "dead_letter_alert"] },
      cancelledAt: nullableTimestamp,
      deadLetteredAt: nullableTimestamp,
      deadLetterReason: { type: ["string", "null"] },
    },
  },
  DeliveryAttempt: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "attemptNumber",
      "requestAt",
      "responseAt",
      "httpStatusCode",
      "responseDurationMs",
      "responseExcerpt",
      "errorClassification",
      "outcome",
    ],
    properties: {
      id: uuid,
      attemptNumber: { type: "integer", minimum: 1 },
      requestAt: timestamp,
      responseAt: nullableTimestamp,
      httpStatusCode: { type: ["integer", "null"], minimum: 100, maximum: 599 },
      responseDurationMs: { type: ["number", "null"], minimum: 0 },
      responseExcerpt: { type: ["string", "null"] },
      errorClassification: { type: ["string", "null"] },
      outcome: { type: "string", enum: ["success", "retry", "failed"] },
    },
  },
  Pagination: {
    type: "object",
    additionalProperties: false,
    required: ["limit", "nextCursor"],
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 100 },
      nextCursor: { type: ["string", "null"] },
    },
  },
  OperationalMetrics: {
    type: "object",
    additionalProperties: false,
    required: [
      "queueBacklog",
      "deliveryStatusCounts",
      "deliveryLatencyMilliseconds",
      "workers",
    ],
    properties: {
      queueBacklog: {
        type: "object",
        required: ["pending", "inFlight"],
        properties: {
          pending: { type: "integer", minimum: 0 },
          inFlight: { type: "integer", minimum: 0 },
        },
      },
      deliveryStatusCounts: {
        type: "object",
        required: ["pending", "inFlight", "delivered", "failed", "cancelled"],
        properties: {
          pending: { type: "integer", minimum: 0 },
          inFlight: { type: "integer", minimum: 0 },
          delivered: { type: "integer", minimum: 0 },
          failed: { type: "integer", minimum: 0 },
          cancelled: { type: "integer", minimum: 0 },
        },
      },
      deliveryLatencyMilliseconds: {
        type: "object",
        required: ["count", "average"],
        properties: {
          count: { type: "integer", minimum: 0 },
          average: { type: "number", minimum: 0 },
        },
      },
      workers: {
        type: "object",
        required: ["active", "configuredConcurrency", "activeJobs", "stale"],
        properties: {
          active: { type: "integer", minimum: 0 },
          configuredConcurrency: { type: "integer", minimum: 0 },
          activeJobs: { type: "integer", minimum: 0 },
          stale: { type: "integer", minimum: 0 },
        },
      },
    },
  },
};

function objectSchema(property: string, schema: Schema): Schema {
  return {
    type: "object",
    additionalProperties: false,
    required: [property],
    properties: { [property]: schema },
  };
}

const paths: Record<string, Record<string, OperationObject>> = {
  "/health": {
    get: {
      summary: "Check API liveness",
      operationId: "getHealth",
      tags: ["Operations"],
      responses: {
        "200": response("The API process is alive", {
          type: "object",
          additionalProperties: false,
          required: ["status", "service"],
          properties: {
            status: { type: "string", enum: ["ok"] },
            service: { type: "string", enum: ["hookforge-api"] },
          },
        }),
      },
    },
  },
  "/ready": {
    get: {
      summary: "Check API dependencies",
      operationId: "getReadiness",
      tags: ["Operations"],
      responses: {
        "200": response("PostgreSQL and Redis are available", {
          type: "object",
          additionalProperties: false,
          required: ["status", "checks"],
          properties: {
            status: { type: "string", enum: ["ready"] },
            checks: {
              type: "object",
              additionalProperties: false,
              required: ["database", "redis"],
              properties: {
                database: { type: "string", enum: ["ok"] },
                redis: { type: "string", enum: ["ok"] },
              },
            },
          },
        }),
        "503": response("A required dependency is unavailable", {
          type: "object",
          additionalProperties: false,
          required: ["status", "checks"],
          properties: {
            status: { type: "string", enum: ["not_ready"] },
            checks: {
              type: "object",
              additionalProperties: false,
              required: ["database", "redis"],
              properties: {
                database: { type: "string", enum: ["ok", "error"] },
                redis: { type: "string", enum: ["ok", "error"] },
              },
            },
          },
        }),
      },
    },
  },
  "/metrics": {
    get: {
      summary: "Read sanitized runtime and operational metrics",
      operationId: "getMetrics",
      tags: ["Operations"],
      responses: {
        "200": response("Metrics snapshot", {
          type: "object",
          additionalProperties: false,
          required: [
            "counters",
            "requestDurationMilliseconds",
            "responseStatusCodes",
            "errors",
            "process",
            "eventLoopLagMilliseconds",
            "operational",
          ],
          properties: {
            counters: {
              type: "object",
              additionalProperties: { type: "number" },
            },
            requestDurationMilliseconds: {
              type: "object",
              required: ["count", "total", "minimum", "maximum", "average"],
              properties: {
                count: { type: "integer", minimum: 0 },
                total: { type: "number", minimum: 0 },
                minimum: { type: "number", minimum: 0 },
                maximum: { type: "number", minimum: 0 },
                average: { type: "number", minimum: 0 },
              },
            },
            responseStatusCodes: {
              type: "object",
              additionalProperties: { type: "integer", minimum: 0 },
            },
            errors: {
              type: "object",
              additionalProperties: { type: "integer", minimum: 0 },
            },
            process: {
              type: "object",
              required: ["uptimeSeconds", "rssBytes", "heapUsedBytes"],
              properties: {
                uptimeSeconds: { type: "number", minimum: 0 },
                rssBytes: { type: "integer", minimum: 0 },
                heapUsedBytes: { type: "integer", minimum: 0 },
              },
            },
            eventLoopLagMilliseconds: { type: ["number", "null"], minimum: 0 },
            operational: ref("OperationalMetrics"),
          },
        }),
      },
    },
  },
  "/openapi.json": {
    get: {
      summary: "Download the API contract",
      operationId: "getOpenApiDocument",
      tags: ["Operations"],
      responses: {
        "200": response("OpenAPI 3.1 document", {
          type: "object",
          description: "This document",
        }),
      },
    },
  },
  "/api/v1/auth/register": {
    post: {
      summary: "Register a user and create a session",
      operationId: "registerUser",
      tags: ["Authentication"],
      requestBody: jsonRequest(
        {
          type: "object",
          additionalProperties: false,
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email", maxLength: 320 },
            password: { type: "string", minLength: 12, maxLength: 128 },
          },
        },
        "Credentials for the new account",
      ),
      responses: {
        "201": response("User and session created", ref("AuthSession")),
        "400": errorResponse("The credentials are invalid"),
        "409": errorResponse("The email is already registered"),
        "429": errorResponse("Authentication rate limit exceeded", true),
      },
    },
  },
  "/api/v1/auth/login": {
    post: {
      summary: "Authenticate a user",
      operationId: "loginUser",
      tags: ["Authentication"],
      requestBody: jsonRequest(
        {
          type: "object",
          additionalProperties: false,
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email", maxLength: 320 },
            password: { type: "string", minLength: 12, maxLength: 128 },
          },
        },
        "Account credentials",
      ),
      responses: {
        "200": response("Session created", ref("AuthSession")),
        "400": errorResponse("The credentials are invalid"),
        "401": errorResponse("The credentials are not valid"),
        "429": errorResponse("Authentication rate limit exceeded", true),
      },
    },
  },
  "/api/v1/auth/me": {
    get: {
      summary: "Get the authenticated user",
      operationId: "getCurrentUser",
      tags: ["Authentication"],
      security: bearerSecurity,
      responses: {
        "200": response(
          "Authenticated user",
          objectSchema("user", ref("User")),
        ),
        "401": errorResponse("Authentication is required"),
      },
    },
  },
  "/api/v1/auth/logout": {
    post: {
      summary: "Revoke the current session",
      operationId: "logoutUser",
      tags: ["Authentication"],
      security: bearerSecurity,
      responses: {
        "204": response("Session revoked"),
        "401": errorResponse("Authentication is required"),
      },
    },
  },
  "/api/v1/projects": {
    post: {
      summary: "Create a project",
      operationId: "createProject",
      tags: ["Projects"],
      security: bearerSecurity,
      requestBody: jsonRequest(
        {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
          },
        },
        "Project name",
      ),
      responses: {
        "201": response(
          "Project created",
          objectSchema("project", ref("Project")),
        ),
        "400": errorResponse("The project name is invalid"),
        "401": errorResponse("Authentication is required"),
        "409": errorResponse("A project with this name already exists"),
      },
    },
    get: {
      summary: "List owned projects",
      operationId: "listProjects",
      tags: ["Projects"],
      security: bearerSecurity,
      parameters: [
        queryParameter(
          "limit",
          { type: "integer", minimum: 1, maximum: 100, default: 50 },
          "Maximum number of projects to return",
        ),
      ],
      responses: {
        "200": response("Owned projects", {
          type: "object",
          additionalProperties: false,
          required: ["projects"],
          properties: { projects: { type: "array", items: ref("Project") } },
        }),
        "400": errorResponse("The query is invalid"),
        "401": errorResponse("Authentication is required"),
      },
    },
  },
  "/api/v1/projects/{projectId}": {
    get: {
      summary: "Get an owned project",
      operationId: "getProject",
      tags: ["Projects"],
      security: bearerSecurity,
      parameters: projectParameters,
      responses: {
        "200": response(
          "Owned project",
          objectSchema("project", ref("Project")),
        ),
        "400": errorResponse("The project ID is invalid"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Project not found"),
      },
    },
  },
  "/api/v1/projects/{projectId}/overview": {
    get: {
      summary: "Get project delivery overview",
      operationId: "getProjectOverview",
      tags: ["Projects"],
      security: bearerSecurity,
      parameters: projectParameters,
      responses: {
        "200": response(
          "Project overview",
          objectSchema("overview", {
            type: "object",
            additionalProperties: false,
            required: ["events", "endpoints", "deliveries"],
            properties: {
              events: { type: "integer", minimum: 0 },
              endpoints: {
                type: "object",
                required: ["active", "paused", "disabled"],
                properties: {
                  active: { type: "integer", minimum: 0 },
                  paused: { type: "integer", minimum: 0 },
                  disabled: { type: "integer", minimum: 0 },
                },
              },
              deliveries: {
                type: "object",
                required: ["pending", "in_flight", "delivered", "failed"],
                properties: {
                  pending: { type: "integer", minimum: 0 },
                  in_flight: { type: "integer", minimum: 0 },
                  delivered: { type: "integer", minimum: 0 },
                  failed: { type: "integer", minimum: 0 },
                },
              },
            },
          }),
        ),
        "400": errorResponse("The project ID is invalid"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Project not found"),
      },
    },
  },
  "/api/v1/projects/{projectId}/endpoints": {
    post: {
      summary: "Create a webhook endpoint",
      operationId: "createEndpoint",
      tags: ["Endpoints"],
      security: bearerSecurity,
      parameters: projectParameters,
      requestBody: jsonRequest(
        {
          type: "object",
          additionalProperties: false,
          required: ["name", "url"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            url: {
              type: "string",
              minLength: 1,
              maxLength: 2048,
              format: "uri",
            },
            headers: {
              type: "object",
              additionalProperties: { type: "string", maxLength: 2048 },
              maxProperties: 20,
            },
            eventPatterns: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: { type: "string", minLength: 1, maxLength: 100 },
            },
          },
        },
        "Endpoint configuration",
      ),
      responses: {
        "201": response(
          "Endpoint created; the signing secret is returned once",
          {
            type: "object",
            additionalProperties: false,
            required: ["endpoint", "signingSecret"],
            properties: {
              endpoint: ref("Endpoint"),
              signingSecret: {
                type: "string",
                description:
                  "Plaintext signing secret. It is never returned again.",
              },
            },
          },
        ),
        "400": errorResponse("The endpoint configuration or URL is invalid"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Project not found"),
        "409": errorResponse("An endpoint with this name already exists"),
      },
    },
    get: {
      summary: "List project endpoints",
      operationId: "listEndpoints",
      tags: ["Endpoints"],
      security: bearerSecurity,
      parameters: [
        ...projectParameters,
        queryParameter(
          "limit",
          { type: "integer", minimum: 1, maximum: 100, default: 50 },
          "Maximum number of endpoints to return",
        ),
      ],
      responses: {
        "200": response("Project endpoints", {
          type: "object",
          additionalProperties: false,
          required: ["endpoints"],
          properties: { endpoints: { type: "array", items: ref("Endpoint") } },
        }),
        "400": errorResponse("The project ID or query is invalid"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Project not found"),
      },
    },
  },
  "/api/v1/projects/{projectId}/endpoints/{endpointId}": {
    get: {
      summary: "Get a webhook endpoint",
      operationId: "getEndpoint",
      tags: ["Endpoints"],
      security: bearerSecurity,
      parameters: endpointParameters,
      responses: {
        "200": response(
          "Endpoint without its signing secret",
          objectSchema("endpoint", ref("Endpoint")),
        ),
        "400": errorResponse("The endpoint or project ID is invalid"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Endpoint not found"),
      },
    },
    patch: {
      summary: "Update a webhook endpoint",
      operationId: "updateEndpoint",
      tags: ["Endpoints"],
      security: bearerSecurity,
      parameters: endpointParameters,
      requestBody: jsonRequest(
        {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            url: {
              type: "string",
              minLength: 1,
              maxLength: 2048,
              format: "uri",
            },
            headers: {
              type: "object",
              additionalProperties: { type: "string", maxLength: 2048 },
              maxProperties: 20,
            },
          },
        },
        "Fields to update; at least one field is required",
      ),
      responses: {
        "200": response(
          "Endpoint updated",
          objectSchema("endpoint", ref("Endpoint")),
        ),
        "400": errorResponse("The endpoint configuration is invalid"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Endpoint not found"),
        "409": errorResponse("An endpoint with this name already exists"),
      },
    },
    delete: {
      summary: "Disable a webhook endpoint",
      operationId: "disableEndpoint",
      tags: ["Endpoints"],
      security: bearerSecurity,
      parameters: endpointParameters,
      responses: {
        "204": response("Endpoint disabled"),
        "400": errorResponse("The endpoint or project ID is invalid"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Endpoint not found"),
      },
    },
  },
  "/api/v1/projects/{projectId}/endpoints/{endpointId}/pause": {
    post: {
      summary: "Pause a webhook endpoint",
      operationId: "pauseEndpoint",
      tags: ["Endpoints"],
      security: bearerSecurity,
      parameters: endpointParameters,
      responses: {
        "200": response(
          "Endpoint paused",
          objectSchema("endpoint", ref("Endpoint")),
        ),
        "400": errorResponse("The endpoint or project ID is invalid"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Endpoint not found"),
        "409": errorResponse("Disabled endpoints cannot change status"),
      },
    },
  },
  "/api/v1/projects/{projectId}/endpoints/{endpointId}/resume": {
    post: {
      summary: "Resume a webhook endpoint",
      operationId: "resumeEndpoint",
      tags: ["Endpoints"],
      security: bearerSecurity,
      parameters: endpointParameters,
      responses: {
        "200": response(
          "Endpoint resumed",
          objectSchema("endpoint", ref("Endpoint")),
        ),
        "400": errorResponse("The endpoint or project ID is invalid"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Endpoint not found"),
        "409": errorResponse("Disabled endpoints cannot change status"),
      },
    },
  },
  "/api/v1/projects/{projectId}/endpoints/{endpointId}/rotate-secret": {
    post: {
      summary: "Rotate an endpoint signing secret",
      operationId: "rotateEndpointSecret",
      tags: ["Endpoints"],
      security: bearerSecurity,
      parameters: endpointParameters,
      responses: {
        "200": response("New secret returned once", {
          type: "object",
          additionalProperties: false,
          required: ["endpoint", "signingSecret"],
          properties: {
            endpoint: ref("Endpoint"),
            signingSecret: {
              type: "string",
              description:
                "Plaintext signing secret. It is never returned again.",
            },
          },
        }),
        "400": errorResponse("The endpoint or project ID is invalid"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Endpoint not found"),
      },
    },
  },
  "/api/v1/projects/{projectId}/endpoints/{endpointId}/subscriptions": {
    get: {
      summary: "List endpoint event subscriptions",
      operationId: "listEndpointSubscriptions",
      tags: ["Endpoints"],
      security: bearerSecurity,
      parameters: endpointParameters,
      responses: {
        "200": response("Endpoint event patterns", {
          type: "object",
          required: ["patterns"],
          properties: {
            patterns: { type: "array", items: { type: "string" } },
          },
        }),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Endpoint not found"),
      },
    },
    put: {
      summary: "Replace endpoint event subscriptions",
      operationId: "replaceEndpointSubscriptions",
      tags: ["Endpoints"],
      security: bearerSecurity,
      parameters: endpointParameters,
      requestBody: jsonRequest(
        {
          type: "object",
          required: ["patterns"],
          properties: {
            patterns: {
              type: "array",
              maxItems: 20,
              items: { type: "string" },
            },
          },
        },
        "Exact event types and terminal-wildcard patterns",
      ),
      responses: {
        "200": response("Subscriptions replaced", {
          type: "object",
          required: ["patterns"],
          properties: {
            patterns: { type: "array", items: { type: "string" } },
          },
        }),
        "400": errorResponse("The subscription patterns are invalid"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Endpoint not found"),
      },
    },
  },
  "/api/v1/projects/{projectId}/sandbox/endpoints": {
    post: {
      summary: "Create an ephemeral local sandbox endpoint",
      operationId: "createSandboxEndpoint",
      tags: ["Sandbox"],
      security: bearerSecurity,
      parameters: projectParameters,
      requestBody: jsonRequest(
        { type: "object", properties: { name: { type: "string" } } },
        "Optional sandbox endpoint name",
      ),
      responses: {
        "201": response("Sandbox endpoint created", {
          type: "object",
          required: ["endpoint", "signingSecret", "sandbox"],
          properties: {
            endpoint: ref("Endpoint"),
            signingSecret: { type: "string" },
            sandbox: {
              type: "object",
              required: ["publicUrl"],
              properties: { publicUrl: { type: "string", format: "uri" } },
            },
          },
        }),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Project not found or sandbox disabled"),
      },
    },
  },
  "/api/v1/projects/{projectId}/endpoints/{endpointId}/sandbox/requests": {
    get: {
      summary: "Inspect captured local sandbox requests",
      operationId: "listSandboxRequests",
      tags: ["Sandbox"],
      security: bearerSecurity,
      parameters: [
        ...endpointParameters,
        queryParameter(
          "limit",
          { type: "integer", minimum: 1, maximum: 100, default: 100 },
          "Maximum captures",
        ),
      ],
      responses: {
        "200": response("Captured sandbox requests", {
          type: "object",
          required: ["requests"],
          properties: {
            requests: { type: "array", items: { type: "object" } },
          },
        }),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Sandbox endpoint not found"),
      },
    },
    delete: {
      summary: "Clear captured local sandbox requests",
      operationId: "clearSandboxRequests",
      tags: ["Sandbox"],
      security: bearerSecurity,
      parameters: endpointParameters,
      responses: {
        "204": response("Sandbox requests cleared"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Sandbox endpoint not found"),
      },
    },
  },
  "/api/v1/projects/{projectId}/events": {
    get: {
      summary: "List project events",
      operationId: "listEvents",
      tags: ["Events"],
      security: bearerSecurity,
      parameters: [
        ...projectParameters,
        ...paginationParameters,
        queryParameter(
          "eventType",
          { type: "string", minLength: 1, maxLength: 100 },
          "Filter by exact event type",
        ),
      ],
      responses: {
        "200": response("Project events", {
          type: "object",
          additionalProperties: false,
          required: ["events", "pagination"],
          properties: {
            events: { type: "array", items: ref("EventSummary") },
            pagination: ref("Pagination"),
          },
        }),
        "400": errorResponse("The project ID or query is invalid"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Project not found"),
      },
    },
    post: {
      summary: "Ingest an event",
      operationId: "ingestEvent",
      tags: ["Events"],
      security: bearerSecurity,
      parameters: [
        ...projectParameters,
        {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          description:
            "Visible ASCII key scoped to the project. Reusing it with the same request is safe.",
          schema: { type: "string", minLength: 1, maxLength: 255 },
        },
      ],
      requestBody: jsonRequest(
        {
          type: "object",
          additionalProperties: false,
          required: ["eventType", "payload"],
          properties: {
            eventType: { type: "string", minLength: 1, maxLength: 100 },
            payload: jsonValue,
          },
        },
        "Event to persist and schedule for active endpoints",
      ),
      responses: {
        "202": response("Event accepted and deliveries scheduled", {
          type: "object",
          additionalProperties: false,
          required: ["event", "deliveriesScheduled", "deduplicated"],
          properties: {
            event: ref("EventSummary"),
            deliveriesScheduled: { type: "integer", minimum: 0 },
            deduplicated: { type: "boolean", enum: [false] },
          },
        }),
        "200": response("A matching idempotency request was deduplicated", {
          type: "object",
          additionalProperties: false,
          required: ["event", "deliveriesScheduled", "deduplicated"],
          properties: {
            event: ref("EventSummary"),
            deliveriesScheduled: { type: "integer", minimum: 0 },
            deduplicated: { type: "boolean", enum: [true] },
          },
        }),
        "400": errorResponse("The event or payload is invalid or too large"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Project not found"),
        "409": errorResponse(
          "The idempotency key was reused for another request",
        ),
        "429": errorResponse("Event ingestion rate limit exceeded", true),
      },
    },
  },
  "/api/v1/projects/{projectId}/deliveries": {
    get: {
      summary: "List project deliveries",
      operationId: "listDeliveries",
      tags: ["Deliveries"],
      security: bearerSecurity,
      parameters: [
        ...projectParameters,
        ...paginationParameters,
        queryParameter(
          "status",
          {
            type: "string",
            enum: ["pending", "in_flight", "delivered", "failed", "cancelled"],
          },
          "Filter by delivery status",
        ),
        queryParameter(
          "kind",
          { type: "string", enum: ["event", "dead_letter_alert"] },
          "Filter by delivery kind",
        ),
        queryParameter(
          "endpointId",
          { type: "string", format: "uuid" },
          "Filter by endpoint UUID",
        ),
        queryParameter(
          "eventType",
          { type: "string", minLength: 1, maxLength: 100 },
          "Filter by exact event type",
        ),
        queryParameter(
          "from",
          { type: "string", format: "date-time" },
          "Inclusive creation-time lower bound",
        ),
        queryParameter(
          "to",
          { type: "string", format: "date-time" },
          "Exclusive creation-time upper bound",
        ),
      ],
      responses: {
        "200": response("Project deliveries", {
          type: "object",
          additionalProperties: false,
          required: ["deliveries", "pagination"],
          properties: {
            deliveries: { type: "array", items: ref("DeliverySummary") },
            pagination: ref("Pagination"),
          },
        }),
        "400": errorResponse("The project ID or filter is invalid"),
        "401": errorResponse("Authentication is required"),
      },
    },
  },
  "/api/v1/projects/{projectId}/deliveries/reconcile": {
    post: {
      summary: "Reconcile expired delivery leases",
      operationId: "reconcileDeliveries",
      tags: ["Deliveries"],
      security: bearerSecurity,
      parameters: projectParameters,
      responses: {
        "200": response("Expired deliveries returned to pending", {
          type: "object",
          additionalProperties: false,
          required: ["reconciledCount"],
          properties: { reconciledCount: { type: "integer", minimum: 0 } },
        }),
        "400": errorResponse("The project ID is invalid"),
        "401": errorResponse("Authentication is required"),
      },
    },
  },
  "/api/v1/projects/{projectId}/deliveries/bulk-replay": {
    post: {
      summary: "Replay selected failed deliveries",
      operationId: "bulkReplayDeliveries",
      tags: ["Deliveries"],
      security: bearerSecurity,
      parameters: [
        ...projectParameters,
        {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          schema: { type: "string", minLength: 1, maxLength: 255 },
        },
      ],
      requestBody: jsonRequest(
        {
          type: "object",
          required: ["deliveryIds"],
          properties: {
            deliveryIds: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: uuid,
            },
          },
        },
        "Selected delivery IDs",
      ),
      responses: {
        "202": response("Selected replays queued", { type: "object" }),
        "400": errorResponse("The selected delivery IDs are invalid"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Project not found"),
      },
    },
  },
  "/api/v1/projects/{projectId}/deliveries/bulk-cancel": {
    post: {
      summary: "Cancel selected pending or in-flight deliveries",
      operationId: "bulkCancelDeliveries",
      tags: ["Deliveries"],
      security: bearerSecurity,
      parameters: [
        ...projectParameters,
        {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          schema: { type: "string", minLength: 1, maxLength: 255 },
        },
      ],
      requestBody: jsonRequest(
        {
          type: "object",
          required: ["deliveryIds"],
          properties: {
            deliveryIds: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: uuid,
            },
            reason: { type: "string", maxLength: 200 },
          },
        },
        "Selected delivery IDs and optional reason",
      ),
      responses: {
        "200": response("Selected deliveries cancelled", { type: "object" }),
        "400": errorResponse("The selected delivery IDs are invalid"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Project not found"),
      },
    },
  },
  "/api/v1/projects/{projectId}/deliveries/{deliveryId}": {
    get: {
      summary: "Inspect a delivery and its attempts",
      operationId: "getDelivery",
      tags: ["Deliveries"],
      security: bearerSecurity,
      parameters: deliveryParameters,
      responses: {
        "200": response("Delivery detail", {
          type: "object",
          additionalProperties: false,
          required: ["delivery", "eventPayload", "attempts"],
          properties: {
            delivery: ref("DeliverySummary"),
            eventPayload: jsonValue,
            attempts: { type: "array", items: ref("DeliveryAttempt") },
          },
        }),
        "400": errorResponse("The delivery or project ID is invalid"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Delivery not found"),
      },
    },
  },
  "/api/v1/projects/{projectId}/deliveries/{deliveryId}/replay": {
    post: {
      summary: "Replay a terminally failed delivery",
      operationId: "replayDelivery",
      tags: ["Deliveries"],
      security: bearerSecurity,
      parameters: deliveryParameters,
      responses: {
        "202": response("Replay delivery queued", {
          type: "object",
          additionalProperties: false,
          required: ["delivery", "replayedFromDeliveryId"],
          properties: {
            delivery: ref("DeliverySummary"),
            replayedFromDeliveryId: uuid,
          },
        }),
        "400": errorResponse("The delivery or project ID is invalid"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Delivery not found"),
        "409": errorResponse("Only eligible failed deliveries can be replayed"),
      },
    },
  },
  "/api/v1/projects/{projectId}/alerts/dead-letter": {
    get: {
      summary: "Get the dead-letter alert destination",
      operationId: "getDeadLetterAlert",
      tags: ["Alerts"],
      security: bearerSecurity,
      parameters: projectParameters,
      responses: {
        "200": response("Dead-letter alert configuration", { type: "object" }),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Project not found"),
      },
    },
    put: {
      summary: "Configure dead-letter alerts",
      operationId: "setDeadLetterAlert",
      tags: ["Alerts"],
      security: bearerSecurity,
      parameters: projectParameters,
      requestBody: jsonRequest(
        {
          type: "object",
          required: ["endpointId"],
          properties: { endpointId: uuid },
        },
        "Owned alert endpoint",
      ),
      responses: {
        "200": response("Dead-letter alerts configured", { type: "object" }),
        "400": errorResponse("The endpoint ID is invalid"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Project or endpoint not found"),
      },
    },
    delete: {
      summary: "Disable dead-letter alerts",
      operationId: "clearDeadLetterAlert",
      tags: ["Alerts"],
      security: bearerSecurity,
      parameters: projectParameters,
      responses: {
        "204": response("Dead-letter alerts disabled"),
        "401": errorResponse("Authentication is required"),
        "404": errorResponse("Project not found"),
      },
    },
  },
};

for (const operations of Object.values(paths)) {
  for (const operation of Object.values(operations)) {
    operation.responses["500"] ??= errorResponse("Internal server error");
  }
}

export const openApiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "HookForge API",
    version: "0.1.0",
    description:
      "Durable, tenant-scoped webhook event ingestion, delivery, inspection, and replay API.",
  },
  servers: [
    {
      url: "http://localhost:3000",
      description: "Local development API",
    },
  ],
  tags: [
    {
      name: "Operations",
      description: "Health, readiness, metrics, and contract",
    },
    { name: "Authentication", description: "Opaque bearer session management" },
    { name: "Projects", description: "Tenant-scoped project management" },
    { name: "Endpoints", description: "Webhook endpoint configuration" },
    { name: "Sandbox", description: "Local mock receiver inspection" },
    { name: "Events", description: "Durable event ingestion and listing" },
    {
      name: "Deliveries",
      description: "Delivery inspection, reconciliation, and replay",
    },
    { name: "Alerts", description: "Dead-letter alert routing" },
  ],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "opaque session token",
        description: "Send the token returned by registration or login.",
      },
    },
    schemas,
  },
};
