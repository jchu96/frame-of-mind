import { fileURLToPath } from "node:url";

const databaseDriver = process.env.FRAME_OF_MIND_DB_DRIVER === "d1" ? "d1" : "sqlite";
const nitroPreset = process.env.NITRO_PRESET || "node-server";
const studioSpikeEnabled = databaseDriver === "sqlite"
  && nitroPreset === "node-server"
  && process.env.FRAME_OF_MIND_STUDIO_SPIKE === "1";
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const storeImplementation = fileURLToPath(
  new URL(`./server/data/${databaseDriver}.ts`, import.meta.url),
);
const spikeUploadHandler = fileURLToPath(
  new URL("./server-local/studio-spike/upload.put.ts", import.meta.url),
);
const spikeMediaHandler = fileURLToPath(
  new URL("./server-local/studio-spike/media.get.ts", import.meta.url),
);

export default defineNuxtConfig({
  compatibilityDate: "2026-07-24",
  devtools: { enabled: true },
  modules: ["@nuxt/ui"],
  css: ["~/assets/css/main.css"],
  alias: {
    "#frame-contracts": `${projectRoot}/src/domain/schemas.ts`,
    "#frame-store": storeImplementation,
  },
  nitro: {
    preset: nitroPreset,
    handlers: studioSpikeEnabled
      ? [
          {
            route: "/api/__studio-spike/upload",
            method: "put",
            handler: spikeUploadHandler,
          },
          {
            route: "/api/__studio-spike/media",
            method: "get",
            handler: spikeMediaHandler,
          },
        ]
      : [],
  },
  runtimeConfig: {
    authMode: "off",
    allowUnauthenticatedRemote: false,
    sqlitePath: ".data/frame-of-mind.sqlite",
    cloudflareAccessTeamDomain: "",
    cloudflareAccessAud: "",
    public: {
      appName: "Frame of Mind",
      appVersion: "0.2.0",
    },
  },
  typescript: {
    strict: true,
    typeCheck: true,
  },
});
