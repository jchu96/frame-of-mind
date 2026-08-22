import { fileURLToPath } from "node:url";
import { DEFAULT_GEMINI_MODEL } from "../../src/adapters/gemini-model";
import {
  HOSTED_MAX_INTERROGATION_CALLS_DEFAULT,
  HOSTED_PRINCIPAL_CAP_UNITS_DEFAULT,
  HOSTED_PROMPT_OUTPUT_HEADROOM_PER_CALL_DEFAULT,
  HOSTED_VIDEO_TOKEN_RATE_DEFAULT,
} from "../workflows/src/spend";
import { shouldRegisterLocalStudioRoutes } from "./server-local/studio-session/session";

const databaseDriver = process.env.FRAME_OF_MIND_DB_DRIVER === "d1" ? "d1" : "sqlite";
const nitroPreset = process.env.NITRO_PRESET || "node-server";
const sentryNuxtEnabled = nitroPreset !== "cloudflare-worker"
  && nitroPreset !== "cloudflare_module";
const studioSpikeEnabled = databaseDriver === "sqlite"
  && nitroPreset === "node-server"
  && process.env.FRAME_OF_MIND_STUDIO_SPIKE === "1";
const hostedWorkflowSpikeEnabled = databaseDriver === "d1"
  && nitroPreset === "cloudflare_module"
  && process.env.FRAME_OF_MIND_HOSTED_WORKFLOW_SPIKE === "1";
const hostedWorkflowsBuilt = databaseDriver === "d1"
  && nitroPreset === "cloudflare_module"
  && process.env.FRAME_OF_MIND_HOSTED_WORKFLOWS === "1";
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
const hostedWorkflowSpikeHandler = fileURLToPath(
  new URL("./server-spikes/hosted-workflows/relay.ts", import.meta.url),
);
const hostedJobsCreateHandler = fileURLToPath(
  new URL("./server-hosted/studio-jobs/create.post.ts", import.meta.url),
);
const hostedJobDetailHandler = fileURLToPath(
  new URL("./server-hosted/studio-jobs/detail.get.ts", import.meta.url),
);
const hostedJobRetryHandler = fileURLToPath(
  new URL("./server-hosted/studio-jobs/retry.post.ts", import.meta.url),
);
const hostedJobCancelHandler = fileURLToPath(
  new URL("./server-hosted/studio-jobs/cancel.post.ts", import.meta.url),
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
const studioHomePage = fileURLToPath(
  new URL("./server-local/studio-ui/home.vue", import.meta.url),
);
const studioLaunchPage = fileURLToPath(
  new URL("./server-local/studio-ui/launch.vue", import.meta.url),
);
const studioRecordingPage = fileURLToPath(
  new URL("./server-local/studio-ui/recording.vue", import.meta.url),
);
const studioContextPage = fileURLToPath(
  new URL("./server-local/studio-ui/context.vue", import.meta.url),
);
const studioIntentPage = fileURLToPath(
  new URL("./server-local/studio-ui/intent.vue", import.meta.url),
);
const studioRunPage = fileURLToPath(
  new URL("./server-local/studio-ui/run.vue", import.meta.url),
);
const studioActivityPage = fileURLToPath(
  new URL("./server-local/studio-ui/activity.vue", import.meta.url),
);
const studioActivityDetailPage = fileURLToPath(
  new URL("./server-local/studio-ui/activity-detail.vue", import.meta.url),
);
const appFrame = fileURLToPath(
  new URL(
    localStudioEnabled
      ? "./server-local/studio-ui/app-frame.vue"
      : "./app/components/ReviewAppFrame.vue",
    import.meta.url,
  ),
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
const studioContextStartup = fileURLToPath(
  new URL("./server-local/studio-context/startup.ts", import.meta.url),
);
const studioJobsStartup = fileURLToPath(
  new URL("./server-local/studio-jobs/startup.ts", import.meta.url),
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
const studioMediaCleanupRetryHandler = fileURLToPath(
  new URL("./server-local/studio-media/cleanup-retry.post.ts", import.meta.url),
);
const studioContextCreateHandler = fileURLToPath(
  new URL("./server-local/studio-context/create.post.ts", import.meta.url),
);
const studioContextDeleteHandler = fileURLToPath(
  new URL("./server-local/studio-context/delete.ts", import.meta.url),
);
const studioContextStatusHandler = fileURLToPath(
  new URL("./server-local/studio-context/status.get.ts", import.meta.url),
);
const studioCatalogHandler = fileURLToPath(
  new URL("./server-local/studio-catalog/index.get.ts", import.meta.url),
);
const studioRecipeCatalogHandler = fileURLToPath(
  new URL("./server-local/studio-catalog/recipes.get.ts", import.meta.url),
);
const studioJobsListHandler = fileURLToPath(
  new URL("./server-local/studio-jobs/index.get.ts", import.meta.url),
);
const studioJobsCreateHandler = fileURLToPath(
  new URL("./server-local/studio-jobs/index.post.ts", import.meta.url),
);
const studioComposerJobsCreateHandler = fileURLToPath(
  new URL("./server-local/studio-jobs/composer.post.ts", import.meta.url),
);
const studioJobDetailHandler = fileURLToPath(
  new URL("./server-local/studio-jobs/detail.get.ts", import.meta.url),
);
const studioJobCancelHandler = fileURLToPath(
  new URL("./server-local/studio-jobs/cancel.post.ts", import.meta.url),
);
const studioJobRetryHandler = fileURLToPath(
  new URL("./server-local/studio-jobs/retry.post.ts", import.meta.url),
);
const studioJobReimportHandler = fileURLToPath(
  new URL("./server-local/studio-jobs/reimport.post.ts", import.meta.url),
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
        {
          route: "/api/studio/media/:id/cleanup-retry",
          method: "post",
          handler: studioMediaCleanupRetryHandler,
        },
        {
          route: "/api/context-files",
          method: "post",
          handler: studioContextCreateHandler,
        },
        {
          route: "/api/context-files/:id",
          method: "get",
          handler: studioContextStatusHandler,
        },
        {
          route: "/api/context-files/:id",
          method: "delete",
          handler: studioContextDeleteHandler,
        },
        {
          route: "/api/studio/catalog/:provider",
          method: "get",
          handler: studioCatalogHandler,
        },
        {
          route: "/api/studio/recipes",
          method: "get",
          handler: studioRecipeCatalogHandler,
        },
        {
          route: "/api/studio/jobs",
          method: "get",
          handler: studioJobsListHandler,
        },
        {
          route: "/api/studio/jobs",
          method: "post",
          handler: studioJobsCreateHandler,
        },
        {
          route: "/api/studio/composer/jobs",
          method: "post",
          handler: studioComposerJobsCreateHandler,
        },
        {
          route: "/api/studio/jobs/:id",
          method: "get",
          handler: studioJobDetailHandler,
        },
        {
          route: "/api/studio/jobs/:id/cancel",
          method: "post",
          handler: studioJobCancelHandler,
        },
        {
          route: "/api/studio/jobs/:id/retry",
          method: "post",
          handler: studioJobRetryHandler,
        },
        {
          route: "/api/studio/jobs/:id/reimport",
          method: "post",
          handler: studioJobReimportHandler,
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
  ...(hostedWorkflowSpikeEnabled
    ? [
        {
          route: "/api/__hosted-workflow-spike",
          method: "post",
          handler: hostedWorkflowSpikeHandler,
        },
        {
          route: "/api/__hosted-workflow-spike/:id",
          method: "get",
          handler: hostedWorkflowSpikeHandler,
        },
      ]
    : []),
  ...(hostedWorkflowsBuilt
    ? [
        {
          route: "/api/hosted/jobs",
          method: "post",
          handler: hostedJobsCreateHandler,
        },
        {
          route: "/api/hosted/jobs/:id",
          method: "get",
          handler: hostedJobDetailHandler,
        },
        {
          route: "/api/hosted/jobs/:id/retry",
          method: "post",
          handler: hostedJobRetryHandler,
        },
        {
          route: "/api/hosted/jobs/:id/cancel",
          method: "post",
          handler: hostedJobCancelHandler,
        },
      ]
    : []),
];

export default defineNuxtConfig({
  compatibilityDate: "2026-07-24",
  devtools: { enabled: true },
  modules: [
    ...(sentryNuxtEnabled ? ["@sentry/nuxt/module"] : []),
    "@nuxt/ui",
  ],
  sentry: {
    telemetry: false,
    sourcemaps: { disable: true },
    bundleSizeOptimizations: { excludeTracing: true },
  },
  // The Sentry module only installs its define-replacement plugin when source
  // maps are enabled. Keep uploads off and enforce the same module option at
  // Vite's boundary so the runtime plugin cannot add BrowserTracing.
  vite: {
    define: { __SENTRY_TRACING__: "false" },
  },
  css: ["~/assets/css/main.css"],
  app: {
    head: {
      link: [
        { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      ],
    },
  },
  plugins: localStudioEnabled ? [studioBootstrapPlugin] : [],
  hooks: {
    "pages:extend"(pages) {
      if (localStudioEnabled) {
        const indexPage = pages.find((page) => page.path === "/");
        if (indexPage) {
          indexPage.file = studioHomePage;
        } else {
          pages.push({
            name: "index",
            path: "/",
            file: studioHomePage,
          });
        }
        pages.push({
          name: "connections",
          path: "/connections",
          file: studioConnectionsPage,
        });
        pages.push({
          name: "studio-launch",
          path: "/__studio/launch",
          file: studioLaunchPage,
        });
        pages.push({
          name: "recording",
          path: "/recording",
          file: studioRecordingPage,
        });
        pages.push({
          name: "context",
          path: "/context",
          file: studioContextPage,
        });
        pages.push({
          name: "intent",
          path: "/intent",
          file: studioIntentPage,
        });
        pages.push({
          name: "run",
          path: "/run",
          file: studioRunPage,
        });
        pages.push({
          name: "activity",
          path: "/activity",
          file: studioActivityPage,
        });
        pages.push({
          name: "activity-detail",
          path: "/activity/:id",
          file: studioActivityDetailPage,
        });
      }
    },
  },
  alias: {
    "#frame-app": appFrame,
    "#frame-contracts": `${projectRoot}/src/domain/schemas.ts`,
    "#frame-store": storeImplementation,
  },
  nitro: {
    preset: nitroPreset,
    handlers: localHandlers,
    plugins: localStudioEnabled
      ? [studioMediaStartup, studioContextStartup, studioJobsStartup]
      : [],
  },
  runtimeConfig: {
    authMode: "off",
    allowUnauthenticatedRemote: false,
    sqlitePath: ".data/frame-of-mind.sqlite",
    cloudflareAccessTeamDomain: "",
    cloudflareAccessAud: "",
    cloudflareAccessAllowInsecureTestJwks: false,
    hostedWorkflowsEnabled: false,
    hostedSpendPrincipalCapUnits: HOSTED_PRINCIPAL_CAP_UNITS_DEFAULT,
    hostedSpendVideoTokensPerSecond: HOSTED_VIDEO_TOKEN_RATE_DEFAULT,
    hostedSpendPromptOutputHeadroomPerCall:
      HOSTED_PROMPT_OUTPUT_HEADROOM_PER_CALL_DEFAULT,
    hostedSpendMaxInterrogationCalls: HOSTED_MAX_INTERROGATION_CALLS_DEFAULT,
    public: {
      appName: "Frame of Mind",
      appVersion: "0.3.0",
      ...(sentryNuxtEnabled
        ? { sentryDsn: process.env.SENTRY_DSN?.trim() ?? "" }
        : {}),
      ...(localStudioEnabled
        ? { studioDefaultModel: DEFAULT_GEMINI_MODEL }
        : {}),
      studioEnabled: localStudioEnabled,
    },
  },
  typescript: {
    strict: true,
    typeCheck: true,
  },
});
