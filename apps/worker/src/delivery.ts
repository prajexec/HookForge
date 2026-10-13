import { decryptSecret } from "./crypto.js";
import type { DeliveryJob } from "./delivery-store.js";
import { validateDeliveryUrl } from "./network.js";
import {
  classifyHttpStatus,
  classifyNetworkError,
  type DeliveryOutcome,
} from "./retry.js";
import { buildSignatureHeaders, stableJson } from "./signature.js";

export interface DeliveryResult {
  requestAt: Date;
  responseAt: Date | null;
  responseDurationMs: number | null;
  httpStatusCode: number | null;
  responseExcerpt: string | null;
  retryAfter: string | null;
  errorClassification: string;
  lastError: string | null;
  outcome: DeliveryOutcome;
}

interface DeliveryOptions {
  encryptionKey: string;
  allowPrivateEndpoints: boolean;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function boundedError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return "Outbound request failed";
}

async function readResponseExcerpt(
  response: Response,
  maxBytes: number,
): Promise<{ excerpt: string; exceededLimit: boolean }> {
  if (!response.body) {
    return { excerpt: "", exceededLimit: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let exceededLimit = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        exceededLimit = true;
        chunks.push(
          chunk.value.slice(
            0,
            Math.max(0, maxBytes - (totalBytes - chunk.value.byteLength)),
          ),
        );
        await reader.cancel();
        break;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(Math.min(totalBytes, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk.slice(0, Math.max(0, bytes.length - offset)), offset);
    offset += chunk.byteLength;
    if (offset >= bytes.length) break;
  }
  return { excerpt: new TextDecoder().decode(bytes), exceededLimit };
}

export async function deliverJob(
  job: DeliveryJob,
  options: DeliveryOptions,
): Promise<DeliveryResult> {
  const now = options.now ?? (() => new Date());
  const requestAt = now();
  let validatedUrl: string;
  let secret: string;
  try {
    validatedUrl = await validateDeliveryUrl(
      job.endpointUrl,
      options.allowPrivateEndpoints,
    );
    secret = decryptSecret(job.encryptedSecret, options.encryptionKey);
  } catch (error) {
    return {
      requestAt,
      responseAt: null,
      responseDurationMs: null,
      httpStatusCode: null,
      responseExcerpt: null,
      retryAfter: null,
      errorClassification:
        error instanceof Error && error.message.startsWith("dns_")
          ? "dns_resolution_failed"
          : "ssrf_or_secret_validation_failed",
      lastError: boundedError(error),
      outcome: "failed",
    };
  }

  const rawBody = stableJson({
    id: job.eventId,
    type: job.eventType,
    payload: job.payload,
  });
  const timestampSeconds = Math.floor(requestAt.getTime() / 1_000);
  const fetchFunction = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.requestTimeoutMs,
  );

  try {
    const response = await fetchFunction(validatedUrl, {
      method: "POST",
      headers: buildSignatureHeaders({
        eventId: job.eventId,
        timestampSeconds,
        rawBody,
        secret,
      }),
      body: rawBody,
      redirect: "error",
      signal: controller.signal,
    });
    const responseAt = now();
    const responseDurationMs = responseAt.getTime() - requestAt.getTime();
    const excerpt = await readResponseExcerpt(
      response,
      options.maxResponseBytes,
    );
    if (excerpt.exceededLimit) {
      return {
        requestAt,
        responseAt,
        responseDurationMs,
        httpStatusCode: response.status,
        responseExcerpt: excerpt.excerpt,
        retryAfter: null,
        errorClassification: "response_too_large",
        lastError: "Receiver response exceeded the configured limit",
        outcome: "failed",
      };
    }
    const classified = classifyHttpStatus(response.status);
    return {
      requestAt,
      responseAt,
      responseDurationMs,
      httpStatusCode: response.status,
      responseExcerpt: excerpt.excerpt,
      retryAfter: response.headers.get("retry-after"),
      errorClassification: classified.classification,
      lastError:
        classified.outcome === "success" ? null : excerpt.excerpt.slice(0, 500),
      outcome: classified.outcome,
    };
  } catch (error) {
    const responseAt = now();
    const timedOut = error instanceof Error && error.name === "AbortError";
    const classified = classifyNetworkError();
    return {
      requestAt,
      responseAt: null,
      responseDurationMs: responseAt.getTime() - requestAt.getTime(),
      httpStatusCode: null,
      responseExcerpt: null,
      retryAfter: null,
      errorClassification: timedOut
        ? "request_timeout"
        : classified.classification,
      lastError: boundedError(error),
      outcome: classified.outcome,
    };
  } finally {
    clearTimeout(timeout);
  }
}
