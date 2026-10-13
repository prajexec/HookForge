export type DeliveryOutcome = "success" | "retry" | "failed";

export interface RetryPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface ClassifiedResponse {
  outcome: DeliveryOutcome;
  classification: string;
}

export function classifyHttpStatus(statusCode: number): ClassifiedResponse {
  if (statusCode >= 200 && statusCode <= 299) {
    return { outcome: "success", classification: "http_success" };
  }
  if (statusCode === 408) {
    return { outcome: "retry", classification: "http_timeout" };
  }
  if (statusCode === 429) {
    return { outcome: "retry", classification: "http_rate_limited" };
  }
  if (statusCode >= 500 && statusCode <= 599) {
    return { outcome: "retry", classification: "http_server_error" };
  }
  if (statusCode >= 300 && statusCode <= 399) {
    return { outcome: "failed", classification: "http_redirect_blocked" };
  }
  return { outcome: "failed", classification: "http_client_error" };
}

export function classifyNetworkError(): ClassifiedResponse {
  return { outcome: "retry", classification: "network_error" };
}

export function calculateBackoffDelay(
  attemptNumber: number,
  policy: RetryPolicy,
  random = Math.random(),
): number {
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.initialDelayMs * 2 ** Math.max(0, attemptNumber - 1),
  );
  const jitter = exponential * policy.jitterRatio * (random * 2 - 1);
  return Math.max(
    0,
    Math.min(policy.maxDelayMs, Math.round(exponential + jitter)),
  );
}

export function parseRetryAfter(
  value: string | null,
  nowMs: number,
  maxDelayMs: number,
): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(maxDelayMs, Math.round(seconds * 1_000));
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.min(maxDelayMs, Math.max(0, date - nowMs));
}
