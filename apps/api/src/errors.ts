export class AppError extends Error {
  public readonly retryAfterSeconds?: number;

  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    options: { retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "AppError";
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

export function badRequest(code: string, message: string): AppError {
  return new AppError(400, code, message);
}

export function unauthorized(message = "Authentication required"): AppError {
  return new AppError(401, "UNAUTHORIZED", message);
}

export function forbidden(message = "Access denied"): AppError {
  return new AppError(403, "FORBIDDEN", message);
}

export function notFound(message = "Resource not found"): AppError {
  return new AppError(404, "NOT_FOUND", message);
}

export function conflict(code: string, message: string): AppError {
  return new AppError(409, code, message);
}

export function tooManyRequests(retryAfterSeconds: number): AppError {
  return new AppError(429, "RATE_LIMIT_EXCEEDED", "Too many requests", {
    retryAfterSeconds,
  });
}
