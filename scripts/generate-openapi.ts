import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { format } from "prettier";

import { openApiDocument } from "../apps/api/src/openapi.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "docs/api/openapi.json");

await mkdir(dirname(output), { recursive: true });
const document = await format(JSON.stringify(openApiDocument), {
  parser: "json",
});
await writeFile(output, document, "utf8");
process.stdout.write(`Generated ${output}\n`);
