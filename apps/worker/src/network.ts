import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import ipaddr from "ipaddr.js";

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

export async function validateDeliveryUrl(
  value: string,
  allowPrivate: boolean,
  resolve = async (hostname: string) =>
    (await lookup(hostname, { all: true, verbatim: true })).map(
      (entry) => entry.address,
    ),
): Promise<string> {
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
  const addresses = isIP(hostname)
    ? [hostname]
    : await resolve(hostname).catch(() => {
        throw new Error("dns_resolution_failed");
      });
  if (!allowPrivate && addresses.some(isBlockedAddress)) {
    throw new Error("unsafe_endpoint_url");
  }
  return parsed.toString();
}
