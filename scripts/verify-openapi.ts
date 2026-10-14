import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { format } from "prettier";

import { openApiDocument } from "../apps/api/src/openapi.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "docs/api/openapi.json");
const expected = await format(JSON.stringify(openApiDocument), {
  parser: "json",
});
const actual = await readFile(output, "utf8");

if (actual !== expected) {
  process.stderr.write(
    "OpenAPI artifact is out of date. Run npm run openapi:generate.\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write("OpenAPI artifact is current.\n");
}
