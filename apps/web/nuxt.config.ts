import { fileURLToPath } from "node:url";
import { shouldRegisterLocalStudioRoutes } from "./server-local/studio-session/session";

const databaseDriver = process.env.FRAME_OF_MIND_DB_DRIVER === "d1" ? "d1" : "sqlite";
const nitroPreset = process.env.NITRO_PRESET || "node-server";
const studioSpikeEnabled = databaseDriver === "sqlite"
  && nitroPreset === "node-server"
  && process.env.FRAME_OF_MIND_STUDIO_SPIKE === "1";
const localStudioEnabled = shouldRegisterLocalStudioRoutes(
  nitroPreset,
  databaseDriver === "sqlite" && process.env.FRAME_OF_MIND_STUDIO === "1",
);
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
const studioBootstrapHandler = fileURLToPath(
  new URL("./server-local/studio-session/bootstrap.post.ts", import.meta.url),
);
const studioSessionMiddleware = fileURLToPath(
  new URL("./server-local/studio-session/require-session.ts", import.meta.url),
);
const studioSessionStatusHandler = fileURLToPath(
  new URL("./server-local/studio-session/status.get.ts", import.meta.url),
);
const studioBootstrapPlugin = fileURLToPath(
  new URL("./server-local/studio-session/bootstrap.client.ts", import.meta.url),
);
const studioConnectionsPage = fileURLToPath(
  new URL("./server-local/studio-ui/connections.vue", import.meta.url),
);
const studioRecordingPage = fileURLToPath(
  new URL("./server-local/studio-ui/recording.vue", import.meta.url),
);
const studioConfigurationStatusHandler = fileURLToPath(
  new URL("./server-local/studio-configuration/status.get.ts", import.meta.url),
);
const studioSecretPutHandler = fileURLToPath(
  new URL("./server-local/studio-configuration/secret.put.ts", import.meta.url),
);
const studioSecretDeleteHandler = fileURLToPath(
  new URL("./server-local/studio-configuration/secret.delete.ts", import.meta.url),
);
const studioOAuthHandler = fileURLToPath(
  new URL("./server-local/studio-configuration/oauth.post.ts", import.meta.url),
);
const studioMediaStartup = fileURLToPath(
  new URL("./server-local/studio-media/startup.ts", import.meta.url),
);
const studioMediaCreateHandler = fileURLToPath(
  new URL("./server-local/studio-media/create.post.ts", import.meta.url),
);
const studioMediaStatusHandler = fileURLToPath(
  new URL("./server-local/studio-media/status.get.ts", import.meta.url),
);
const studioMediaPartHandler = fileURLToPath(
  new URL("./server-local/studio-media/part.put.ts", import.meta.url),
);
const studioMediaCompleteHandler = fileURLToPath(
  new URL("./server-local/studio-media/complete.post.ts", import.meta.url),
);
const studioMediaAbortHandler = fileURLToPath(
  new URL("./server-local/studio-media/abort.delete.ts", import.meta.url),
);

const localHandlers = [
  ...(localStudioEnabled
    ? [
        {
          route: "/__studio/bootstrap",
          method: "post",
          handler: studioBootstrapHandler,
        },
        {
          middleware: true,
          handler: studioSessionMiddleware,
        },
        {
          route: "/api/studio/session",
          method: "get",
          handler: studioSessionStatusHandler,
        },
        {
          route: "/api/studio/configuration",
          method: "get",
          handler: studioConfigurationStatusHandler,
        },
        {
          route: "/api/studio/configuration/secrets/:name",
          method: "put",
          handler: studioSecretPutHandler,
        },
        {
          route: "/api/studio/configuration/secrets/:name",
          method: "delete",
          handler: studioSecretDeleteHandler,
        },
        {
          route: "/api/studio/connections/:provider/oauth",
          method: "post",
          handler: studioOAuthHandler,
        },
        {
          route: "/api/studio/media",
          method: "post",
          handler: studioMediaCreateHandler,
        },
        {
          route: "/api/studio/media/:id",
          method: "get",
          handler: studioMediaStatusHandler,
        },
        {
          route: "/api/studio/media/:id/parts/:part",
          method: "put",
          handler: studioMediaPartHandler,
        },
        {
          route: "/api/studio/media/:id/complete",
          method: "post",
          handler: studioMediaCompleteHandler,
        },
        {
          route: "/api/studio/media/:id",
          method: "delete",
          handler: studioMediaAbortHandler,
        },
      ]
    : []),
  ...(studioSpikeEnabled
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
    : []),
];

export default defineNuxtConfig({
  compatibilityDate: "2026-07-24",
  devtools: { enabled: true },
  modules: ["@nuxt/ui"],
  css: ["~/assets/css/main.css"],
  plugins: localStudioEnabled ? [studioBootstrapPlugin] : [],
  hooks: {
    "pages:extend"(pages) {
      if (localStudioEnabled) {
        pages.push({
          name: "connections",
          path: "/connections",
          file: studioConnectionsPage,
        });
        pages.push({
          name: "recording",
          path: "/recording",
          file: studioRecordingPage,
        });
      }
    },
  },
  alias: {
    "#frame-contracts": `${projectRoot}/src/domain/schemas.ts`,
    "#frame-store": storeImplementation,
  },
  nitro: {
    preset: nitroPreset,
    handlers: localHandlers,
    plugins: localStudioEnabled ? [studioMediaStartup] : [],
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
      studioEnabled: localStudioEnabled,
    },
  },
  typescript: {
    strict: true,
    typeCheck: true,
  },
});
