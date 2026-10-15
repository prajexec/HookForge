/* global process */

import { execFileSync } from "node:child_process";

const output = execFileSync(
  "docker",
  ["compose", "config", "--format", "json"],
  { encoding: "utf8" },
);
const config = JSON.parse(output);
const services = config.services ?? {};
const requiredServices = [
  "postgres",
  "redis",
  "migrate",
  "api",
  "worker",
  "mock-receiver",
  "web",
];

for (const service of requiredServices) {
  if (!services[service])
    throw new Error(`Missing Compose service: ${service}`);
}

const requiredBuildTargets = {
  api: "api",
  migrate: "migrate",
  worker: "worker",
  "mock-receiver": "mock-receiver",
  web: "web",
};
for (const [service, target] of Object.entries(requiredBuildTargets)) {
  if (services[service].build?.target !== target) {
    throw new Error(`Service ${service} must use Docker target ${target}`);
  }
}

if (
  services.api.healthcheck === undefined ||
  services.web.healthcheck === undefined
) {
  throw new Error("API and web services must have health checks");
}
if (services.worker.healthcheck === undefined) {
  throw new Error("Worker service must have a heartbeat health check");
}
if (services["mock-receiver"].healthcheck === undefined) {
  throw new Error("Mock receiver service must have a health check");
}
const mockReceiverHealthcheck = JSON.stringify(
  services["mock-receiver"].healthcheck.test,
);
if (!mockReceiverHealthcheck.includes("/health")) {
  throw new Error("Mock receiver health check must call /health");
}
const mockReceiverPorts = services["mock-receiver"].ports ?? [];
if (
  !mockReceiverPorts.some(
    (port) =>
      port.host_ip === "127.0.0.1" &&
      port.target === 8080 &&
      (typeof port.published === "number" ||
        (typeof port.published === "string" && port.published.length > 0)),
  )
) {
  throw new Error("Mock receiver must publish port 8080 on loopback only");
}
if (
  services.api.depends_on?.migrate?.condition !==
  "service_completed_successfully"
) {
  throw new Error("API must wait for migrations to complete");
}
if (
  services.worker.depends_on?.migrate?.condition !==
  "service_completed_successfully"
) {
  throw new Error("Worker must wait for migrations to complete");
}
if (services.web.depends_on?.api?.condition !== "service_healthy") {
  throw new Error("Web must wait for API readiness");
}

process.stdout.write(
  `Deployment configuration verified: ${requiredServices.join(", ")}\n`,
);
