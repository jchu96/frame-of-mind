import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadNuxtConfig } from "nuxt/kit";
import { VERSION } from "../../../src/version";

test("defaults the public app version to the CLI version", async () => {
  const config = await loadNuxtConfig({
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    dotenv: false,
  });
  expect(config.runtimeConfig.public.appVersion).toBe(VERSION);
});
