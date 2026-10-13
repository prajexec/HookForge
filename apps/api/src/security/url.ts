import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import ipaddr from "ipaddr.js";

import { badRequest } from "../errors.js";

export interface EndpointUrlValidator {
  validate(url: string): Promise<string>;
}

export interface EndpointUrlValidatorOptions {
  allowPrivate: boolean;
  resolve?: (hostname: string) => Promise<string[]>;
}

const MAX_ENDPOINT_URL_LENGTH = 2_048;
const blockedHostnames = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "instance-data.ec2.internal",
]);

function isBlockedAddress(address: string): boolean {
  const parsed = ipaddr.parse(address);
  const range = parsed.range();

  return [
    "loopback",
    "private",
    "linkLocal",
    "uniqueLocal",
    "unspecified",
    "carrierGradeNat",
    "multicast",
    "reserved",
    "ipv4Mapped",
  ].includes(range);
}

function validateBasicUrl(value: string): URL {
  if (value.length === 0 || value.length > MAX_ENDPOINT_URL_LENGTH) {
    throw badRequest(
      "INVALID_ENDPOINT_URL",
      "Endpoint URL has an invalid length",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest("INVALID_ENDPOINT_URL", "Endpoint URL is invalid");
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !parsed.hostname
  ) {
    throw badRequest(
      "INVALID_ENDPOINT_URL",
      "Endpoint URL must be HTTP(S) without credentials or fragments",
    );
  }

  return parsed;
}

export function createEndpointUrlValidator({
  allowPrivate,
  resolve = async (hostname) =>
    (await lookup(hostname, { all: true, verbatim: true })).map(
      (entry) => entry.address,
    ),
}: EndpointUrlValidatorOptions): EndpointUrlValidator {
  return {
    validate: async (value) => {
      const parsed = validateBasicUrl(value);
      const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

      if (!allowPrivate && blockedHostnames.has(hostname)) {
        throw badRequest(
          "UNSAFE_ENDPOINT_URL",
          "Endpoint URL resolves to a blocked network address",
        );
      }

      const addresses = isIP(hostname)
        ? [hostname]
        : await resolve(hostname).catch(() => {
            throw badRequest(
              "UNSAFE_ENDPOINT_URL",
              "Endpoint hostname could not be resolved",
            );
          });

      if (
        !allowPrivate &&
        addresses.some((address) => isBlockedAddress(address))
      ) {
        throw badRequest(
          "UNSAFE_ENDPOINT_URL",
          "Endpoint URL resolves to a blocked network address",
        );
      }

      return parsed.toString();
    },
  };
}
