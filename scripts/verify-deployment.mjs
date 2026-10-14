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
