import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import ipaddr from "ipaddr.js";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface ResolvedDeliveryTarget {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
}

export type DeliveryAddressResolver = (
  hostname: string,
) => Promise<ResolvedAddress[]>;

const blockedHostnames = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "instance-data.ec2.internal",
]);

function isBlockedAddress(address: string): boolean {
  const range = ipaddr.parse(address).range();
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

const defaultResolve: DeliveryAddressResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));

export async function resolveDeliveryTarget(
  value: string,
  allowPrivate: boolean,
  resolve: DeliveryAddressResolver = defaultResolve,
): Promise<ResolvedDeliveryTarget> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid_endpoint_url");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !parsed.hostname
  ) {
    throw new Error("unsafe_endpoint_url");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!allowPrivate && blockedHostnames.has(hostname)) {
    throw new Error("unsafe_endpoint_url");
  }
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await resolve(hostname).catch(() => {
        throw new Error("dns_resolution_failed");
      });
  if (addresses.length === 0) {
    throw new Error("dns_resolution_failed");
  }
  if (addresses.some(({ address, family }) => isIP(address) !== family)) {
    throw new Error("dns_resolution_failed");
  }
  if (
    !allowPrivate &&
    addresses.some(({ address }) => isBlockedAddress(address))
  ) {
    throw new Error("unsafe_endpoint_url");
  }
  const selected = addresses[0]!;
  return {
    url: parsed,
    hostname,
    address: selected.address,
    family: selected.family,
  };
}

// Kept as a URL-only compatibility helper for callers that only need policy
// validation. Delivery itself must use resolveDeliveryTarget so the validated
// address is also supplied to the socket connection.
export async function validateDeliveryUrl(
  value: string,
  allowPrivate: boolean,
  resolve?: (hostname: string) => Promise<string[]>,
): Promise<string> {
  const resolver: DeliveryAddressResolver = resolve
    ? async (hostname) =>
        (await resolve(hostname)).map((address) => ({
          address,
          family: isIP(address) as 4 | 6,
        }))
    : defaultResolve;
  return (
    await resolveDeliveryTarget(value, allowPrivate, resolver)
  ).url.toString();
}
