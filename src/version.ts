import { readFileSync } from "node:fs";

// Both src/ and installed dist/ sit directly beneath the package manifest.
export const VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
