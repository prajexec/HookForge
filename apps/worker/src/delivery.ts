import { decryptSecret, decryptSecretWithKey } from "./crypto.js";
import type { DeliveryJob } from "./delivery-store.js";
import { requestPinned } from "./http-client.js";
import {
  resolveDeliveryTarget,
  type DeliveryAddressResolver,
  type ResolvedDeliveryTarget,
} from "./network.js";
import {
  classifyHttpStatus,
  classifyNetworkError,
  type DeliveryOutcome,
} from "./retry.js";
import { buildSignatureHeaders, stableJson } from "./signature.js";
import {
  extractTraceContext,
  injectTraceHeaders,
  withSpan,
} from "./telemetry.js";

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
  requestImpl?: (
    target: ResolvedDeliveryTarget,
    init: {
      method: "POST";
      headers: Record<string, string>;
      body: string;
      signal: AbortSignal;
    },
  ) => Promise<Response>;
  resolve?: DeliveryAddressResolver;
  now?: () => Date;
  resolveEncryptionKey?: (version: number) => Promise<Buffer>;
  allowLegacyEncryption?: boolean;
}

async function decryptJobSecret(
  encrypted: Parameters<typeof decryptSecret>[0],
  options: DeliveryOptions,
): Promise<string> {
  if (encrypted.encryptionKeyVersion !== undefined) {
    if (!options.resolveEncryptionKey) {
      throw new Error("Envelope key resolver is not configured");
    }
    return decryptSecretWithKey(
      encrypted,
      await options.resolveEncryptionKey(encrypted.encryptionKeyVersion),
    );
  }
  if (options.allowLegacyEncryption === false) {
    throw new Error(
      "Legacy ciphertext is disabled without SECRET_ENCRYPTION_KEY",
    );
  }
  return decryptSecret(encrypted, options.encryptionKey);
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
  return withSpan(
    "hookforge.delivery",
    async () => deliverJobInternal(job, options),
    extractTraceContext({
      traceparent: job.traceparent,
      tracestate: job.tracestate,
    }),
  );
}

async function deliverJobInternal(
  job: DeliveryJob,
  options: DeliveryOptions,
): Promise<DeliveryResult> {
  const now = options.now ?? (() => new Date());
  const requestAt = now();
  let target: ResolvedDeliveryTarget;
  let secret: string;
  let staticHeaders: Record<string, string>;
  try {
    target = await resolveDeliveryTarget(
      job.endpointUrl,
      options.allowPrivateEndpoints,
      options.resolve,
    );
    secret = await decryptJobSecret(job.encryptedSecret, options);
    staticHeaders = Object.fromEntries(
      await Promise.all(
        Object.entries(job.encryptedStaticHeaders).map(
          async ([name, encrypted]) => {
            const value = await decryptJobSecret(encrypted, options);
            if (/[\r\n]/.test(value)) {
              throw new Error("Custom header values must not contain CR/LF");
            }
            return [name, value];
          },
        ),
      ),
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "";
    return {
      requestAt,
      responseAt: null,
      responseDurationMs: null,
      httpStatusCode: null,
      responseExcerpt: null,
      retryAfter: null,
      errorClassification: errorMessage.startsWith("dns_")
        ? "dns_resolution_failed"
        : /(?:Vault|Envelope|encryption key|auth tag)/i.test(errorMessage)
          ? "encryption_decryption_failed"
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
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.requestTimeoutMs,
  );

  try {
    const requestHeaders = {
      ...staticHeaders,
      "x-hookforge-delivery-id": job.id,
      ...buildSignatureHeaders({
        eventId: job.eventId,
        timestampSeconds,
        rawBody,
        secret,
      }),
    };
    const requestInit = {
      method: "POST",
      headers: requestHeaders,
      body: rawBody,
      signal: controller.signal,
    } as const;
    const response = await withSpan("hookforge.http.receiver", async () => {
      injectTraceHeaders(requestHeaders);
      return options.requestImpl
        ? options.requestImpl(target, requestInit)
        : requestPinned(target, requestInit);
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
