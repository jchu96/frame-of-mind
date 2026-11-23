import { readFileSync } from "node:fs";

// Bun substitutes the release version only when building the standalone CLI.
declare const __FRAMEOFMIND_RELEASE_VERSION__: string;
export const IS_RELEASE_BUNDLE = typeof __FRAMEOFMIND_RELEASE_VERSION__ !== "undefined";
export const VERSION: string = IS_RELEASE_BUNDLE
  ? __FRAMEOFMIND_RELEASE_VERSION__
  : JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
