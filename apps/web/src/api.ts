export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  idempotencyKey?: string;
}

export interface ApiClient {
  request<T>(path: string, options?: ApiOptions): Promise<T>;
}

// Only same-origin relative API paths are permitted. Vite proxies these in dev;
// a production reverse proxy must provide the same /api/v1 path.
export function createApiClient(
  token: string | null,
  onUnauthorized: () => void = () => {},
  fetchImpl: typeof fetch = fetch,
): ApiClient {
  return {
    async request<T>(path: string, options: ApiOptions = {}): Promise<T> {
      if (!path.startsWith("/api/v1/")) {
        throw new Error("Expected a relative /api/v1/ path");
      }
      const headers = new Headers({ accept: "application/json" });
      if (token) headers.set("authorization", `Bearer ${token}`);
      if (options.body !== undefined)
        headers.set("content-type", "application/json");
      if (options.idempotencyKey)
        headers.set("idempotency-key", options.idempotencyKey);
      let response: Response;
      try {
        response = await fetchImpl(path, {
          method: options.method ?? "GET",
          headers,
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          ...(options.body !== undefined
            ? { body: JSON.stringify(options.body) }
            : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        throw new ApiError(
          "Cannot reach HookForge. Check that the API is running.",
          0,
        );
      }
      if (response.status === 401 && token) onUnauthorized();
      if (response.status === 204 && response.ok) return undefined as T;
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const envelope = data as {
          error?: { message?: unknown };
          requestId?: unknown;
        } | null;
        throw new ApiError(
          typeof envelope?.error?.message === "string"
            ? envelope.error.message
            : `Request failed (${response.status}). Try again.`,
          response.status,
          typeof envelope?.requestId === "string"
            ? envelope.requestId
            : undefined,
        );
      }
      if (data === null)
        throw new ApiError(
          "The API returned an invalid response.",
          response.status,
        );
      return data as T;
    },
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.requestId) {
    return `${error.message} (request ${error.requestId})`;
  }
  return error instanceof Error
    ? error.message
    : "Something went wrong. Try again.";
}

export function projectPath(projectId: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}`;
}
