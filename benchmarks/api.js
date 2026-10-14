/* global __ENV, __ITER, __VU */

import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";

const baseUrl = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const authToken = __ENV.AUTH_TOKEN || "";
const projectId = __ENV.PROJECT_ID || "";
const duration = __ENV.DURATION || "15s";

function configuredVus() {
  if (!__ENV.VUS) return 10;

  const value = Number(__ENV.VUS);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("VUS must be a positive integer");
  }
  return value;
}

const vus = configuredVus();
const eventIngestionLatency = new Trend("event_ingestion_latency", true);
const healthReadLatency = new Trend("health_read_latency", true);
const overviewReadLatency = new Trend("overview_read_latency", true);

export const options = {
  scenarios: {
    event_ingestion: {
      executor: "constant-vus",
      vus,
      duration,
      exec: "eventIngestion",
      tags: { workload: "event_ingestion" },
    },
    health_read: {
      executor: "constant-vus",
      vus,
      duration,
      exec: "healthRead",
      tags: { workload: "health_read" },
    },
    overview_read: {
      executor: "constant-vus",
      vus,
      duration,
      exec: "overviewRead",
      tags: { workload: "overview_read" },
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
  },
};

function authenticatedParams() {
  return {
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
  };
}

function requireAuthenticatedConfig() {
  const missing = [];
  if (!authToken) missing.push("AUTH_TOKEN");
  if (!projectId) missing.push("PROJECT_ID");

  if (missing.length > 0) {
    throw new Error(
      `Missing required benchmark environment variable(s): ${missing.join(", ")}`,
    );
  }
}

export function setup() {
  requireAuthenticatedConfig();
}

export function eventIngestion() {
  const response = http.post(
    `${baseUrl}/api/v1/projects/${projectId}/events`,
    JSON.stringify({
      eventType: "benchmark.event",
      payload: {
        benchmark: "hookforge",
        iteration: __ITER,
        sentAt: new Date().toISOString(),
        vu: __VU,
      },
    }),
    authenticatedParams(),
  );

  eventIngestionLatency.add(response.timings.duration);
  check(response, {
    "event ingestion is accepted": (result) => result.status === 202,
  });
}

export function healthRead() {
  const response = http.get(`${baseUrl}/health`);

  healthReadLatency.add(response.timings.duration);
  check(response, {
    "health read is successful": (result) => result.status === 200,
  });
}

export function overviewRead() {
  const response = http.get(
    `${baseUrl}/api/v1/projects/${projectId}/overview`,
    authenticatedParams(),
  );

  overviewReadLatency.add(response.timings.duration);
  check(response, {
    "overview read is successful": (result) => result.status === 200,
  });
}
