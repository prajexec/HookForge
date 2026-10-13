import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "../src/api.js";
import type { ApiError } from "../src/api.js";

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("dashboard API client", () => {
  it("sends bearer, JSON, and idempotency headers without persisting credentials", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ ok: true }));
    const api = createApiClient("session-token", undefined, fetchImpl);

    await expect(
      api.request<{ ok: boolean }>("/api/v1/projects/project/events", {
        method: "POST",
        body: { eventType: "test", payload: {} },
        idempotencyKey: "request-1",
      }),
    ).resolves.toEqual({ ok: true });

    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer session-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe("request-1");
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
  });

  it("clears authentication on 401 and exposes safe API errors", async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        {
          error: { message: "Invalid or expired session" },
          requestId: "request-123",
        },
        { status: 401 },
      ),
    );
    const api = createApiClient("expired", onUnauthorized, fetchImpl);

    await expect(
      api.request("/api/v1/auth/me"),
    ).rejects.toMatchObject<ApiError>({
      status: 401,
      requestId: "request-123",
      message: "Invalid or expired session",
    });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("rejects absolute or non-versioned paths before making a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = createApiClient(null, undefined, fetchImpl);

    await expect(
      api.request("https://example.com/api/v1/projects"),
    ).rejects.toThrow("Expected a relative /api/v1/ path");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
