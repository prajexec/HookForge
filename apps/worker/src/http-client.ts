import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

import type { ResolvedDeliveryTarget } from "./network.js";

export interface PinnedRequestInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

function responseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  return result;
}

/**
 * Sends one request to the exact address returned by the worker's SSRF
 * validation. The URL hostname is retained for Host/SNI/certificate checks;
 * only the DNS lookup used by the socket is overridden.
 */
export function requestPinned(
  target: ResolvedDeliveryTarget,
  init: PinnedRequestInit,
): Promise<Response> {
  const isHttps = target.url.protocol === "https:";
  const requestFunction = isHttps ? httpsRequest : httpRequest;
  const headers = {
    ...Object.fromEntries(
      Object.entries(init.headers).filter(
        ([name]) => name.toLowerCase() !== "host",
      ),
    ),
    host: target.url.host,
  };

  return new Promise<Response>((resolve, reject) => {
    const request = requestFunction(
      {
        protocol: target.url.protocol,
        hostname: target.hostname,
        port: target.url.port || undefined,
        path: `${target.url.pathname}${target.url.search}`,
        method: init.method,
        headers,
        agent: false,
        signal: init.signal,
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [
              { address: target.address, family: target.family },
            ]);
          } else {
            callback(null, target.address, target.family);
          }
        },
        ...(isHttps
          ? {
              rejectUnauthorized: true,
              ...(isIP(target.hostname) === 0
                ? { servername: target.hostname }
                : {}),
            }
          : {}),
      },
      (response) => {
        const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
        resolve(
          new Response(body, {
            status: response.statusCode ?? 500,
            headers: responseHeaders(response.headers),
          }),
        );
      },
    );

    request.once("error", reject);
    request.end(init.body);
  });
}
