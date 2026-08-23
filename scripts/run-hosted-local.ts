import { createServer, request as httpRequest, type Server } from "node:http";
import { URL } from "node:url";
import {
  hasBetterAuthSupport,
  startHostedHarness,
  type HostedAuthMode,
} from "../apps/web/e2e/support/hosted-harness";
import { reserveFreePort } from "../apps/web/e2e/support/isolation";

const requestedMode = parseMode(process.argv.slice(2));
const authMode: HostedAuthMode = requestedMode === "better-auth"
  && !hasBetterAuthSupport()
  ? "cloudflare-access"
  : requestedMode;

if (requestedMode === "better-auth" && authMode !== requestedMode) {
  console.log("HOSTED LOCAL better-auth=SKIP PR #75 files absent; using cloudflare-access helper");
}

let gateway: Server | undefined;
const hosted = await startHostedHarness(authMode, {
  onMail(message) {
    const link = magicLinkFrom(message);
    console.log(`HOSTED LOCAL MAGIC LINK ${link || JSON.stringify(message)}`);
  },
});

try {
  let publicUrl = hosted.baseUrl;
  if (authMode === "cloudflare-access") {
    const session = await hosted.session("a");
    const started = await startAccessProxy(hosted.baseUrl, session.headers);
    gateway = started.server;
    publicUrl = started.url;
    console.log(`HOSTED LOCAL ACCESS HELPER ${publicUrl}`);
  } else {
    const started = await startBetterAuthLoginHelper(hosted.baseUrl);
    gateway = started.server;
    publicUrl = `${started.url}/login?email=tester%40example.test`;
    console.log(`HOSTED LOCAL BETTER AUTH LOGIN ${publicUrl}`);
  }
  console.log(`HOSTED LOCAL ${publicUrl}`);
  console.log("HOSTED LOCAL TEST USER tester@example.test");
  console.log(`HOSTED LOCAL AUTH MODE ${authMode}`);
  console.log("HOSTED LOCAL READY; press Ctrl+C to stop");
  await waitForShutdown();
} finally {
  if (gateway?.listening) {
    await new Promise<void>((resolve, reject) => {
      gateway!.close((error) => error ? reject(error) : resolve());
    });
  }
  await hosted.close();
}

function parseMode(args: string[]): HostedAuthMode {
  const index = args.indexOf("--mode");
  const value = index >= 0 ? args[index + 1] : "better-auth";
  if (value === "cloudflare-access" || value === "better-auth") return value;
  throw new Error("--mode must be better-auth or cloudflare-access");
}

function magicLinkFrom(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  for (const key of ["url", "link", "magicLink"]) {
    const value = (message as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

async function startAccessProxy(
  target: string,
  authentication: Record<string, string>,
): Promise<{ server: Server; url: string }> {
  const targetUrl = new URL(target);
  const port = await reserveFreePort();
  const server = createServer((incoming, outgoing) => {
    const upstream = httpRequest({
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      path: incoming.url,
      method: incoming.method,
      headers: { ...incoming.headers, ...authentication },
    }, (response) => {
      outgoing.writeHead(response.statusCode || 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", (error) => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end(`Hosted local proxy failed: ${error.message}`);
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return { server, url: `http://127.0.0.1:${port}` };
}

async function startBetterAuthLoginHelper(
  target: string,
): Promise<{ server: Server; url: string }> {
  const port = await reserveFreePort();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/login") {
        response.writeHead(404).end("Use /login?email=tester@example.test");
        return;
      }
      const email = url.searchParams.get("email") || "tester@example.test";
      const signIn = await fetch(`${target}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: target,
        },
        body: JSON.stringify({
          provider: "github",
          loginHint: email,
          callbackURL: "/hosted/new/intent",
        }),
      });
      const body = await signIn.json() as { url?: string; message?: string };
      if (!signIn.ok || !body.url) {
        response.writeHead(signIn.status, { "content-type": "text/plain" });
        response.end(body.message || "Better Auth fixture sign-in failed.");
        return;
      }
      const cookies = signIn.headers.getSetCookie();
      response.writeHead(302, {
        location: body.url,
        ...(cookies.length ? { "set-cookie": cookies } : {}),
      });
      response.end();
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return { server, url: `http://127.0.0.1:${port}` };
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
