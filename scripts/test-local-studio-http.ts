const bootstrapToken = "studio-http-test-bootstrap-capability-0123456789";
const port = 34_000 + Math.floor(Math.random() * 10_000);
const baseUrl = `http://127.0.0.1:${port}`;
const environment = {
  ...process.env,
  FRAME_OF_MIND_STUDIO: "1",
  FRAME_OF_MIND_STUDIO_BOOTSTRAP_TOKEN: bootstrapToken,
  HOST: "127.0.0.1",
  NITRO_HOST: "127.0.0.1",
  PORT: String(port),
  NITRO_PORT: String(port),
};
delete environment.NITRO_UNIX_SOCKET;

async function expectStatus(
  response: Response,
  expected: number,
  label: string,
): Promise<Response> {
  if (response.status !== expected) {
    throw new Error(
      `${label}: expected HTTP ${expected}, received ${response.status}: `
      + await response.text(),
    );
  }
  return response;
}

function createStudioProbe(origin: string) {
  let cookie = "";
  const jsonHeaders = () => ({
    "content-type": "application/json",
    origin,
    ...(cookie ? { cookie } : {}),
  });

  return {
    async bootstrap(token: string, headers: Record<string, string> = {}) {
      const response = await fetch(`${origin}/__studio/bootstrap`, {
        method: "POST",
        headers: { ...jsonHeaders(), ...headers },
        body: JSON.stringify({ token }),
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";", 1)[0] || "";
      return response;
    },
    get(path: string, headers: Record<string, string> = {}) {
      return fetch(`${origin}${path}`, {
        headers: { ...(cookie ? { cookie } : {}), ...headers },
        redirect: "manual",
      });
    },
    mutate(
      path: string,
      method: "PUT" | "DELETE",
      body: unknown,
      headers: Record<string, string> = {},
    ) {
      return fetch(`${origin}${path}`, {
        method,
        headers: { ...jsonHeaders(), ...headers },
        body: JSON.stringify(body),
      });
    },
  };
}

console.log("Building the local Studio HTTP contract fixture...");
const build = Bun.spawn(["bun", "run", "--cwd", "apps/web", "build"], {
  cwd: process.cwd(),
  env: environment,
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
if (await build.exited !== 0) {
  throw new Error("Local Studio contract fixture build failed.");
}

const server = Bun.spawn(["bun", ".output/server/index.mjs"], {
  cwd: `${process.cwd()}/apps/web`,
  env: environment,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "inherit",
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/studio/session`);
      if (response.status === 401) {
        ready = true;
        break;
      }
    } catch {
      // Listener is not ready.
    }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("Local Studio contract server did not become ready.");

  const probe = createStudioProbe(baseUrl);
  await expectStatus(
    await probe.get("/connections?probe=1"),
    401,
    "query-bearing Connections page requires a session",
  );
  await expectStatus(
    await probe.get("/connections/"),
    401,
    "trailing-slash Connections page requires a session",
  );
  await expectStatus(
    await probe.get("/api/studio/session", { host: "attacker.example" }),
    403,
    "hostile Host fails closed",
  );
  await expectStatus(
    await probe.bootstrap(bootstrapToken, {
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    }),
    403,
    "cross-site bootstrap fails closed",
  );
  await expectStatus(
    await fetch(`${baseUrl}/__studio/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
      },
      body: JSON.stringify({ token: "x".repeat(2_048) }),
    }),
    413,
    "oversized bootstrap fails closed",
  );

  const bootstrap = await expectStatus(
    await probe.bootstrap(bootstrapToken),
    200,
    "bootstrap exchange succeeds once",
  );
  const bootstrapBody = await bootstrap.json() as { redirect?: string };
  if (bootstrapBody.redirect !== "/connections") {
    throw new Error("Bootstrap did not return the clean Connections path.");
  }
  await expectStatus(
    await probe.bootstrap(bootstrapToken),
    403,
    "bootstrap replay fails closed",
  );
  await expectStatus(
    await probe.get("/api/studio/session"),
    200,
    "session cookie authorizes Studio APIs",
  );

  const secret = "studio-http-test-secret-value";
  await expectStatus(
    await probe.mutate(
      "/api/studio/configuration/secrets/gemini-api-key",
      "PUT",
      { value: secret },
      {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    ),
    403,
    "cross-site secret mutation fails closed",
  );
  const stored = await expectStatus(
    await probe.mutate(
      "/api/studio/configuration/secrets/gemini-api-key",
      "PUT",
      { value: secret },
    ),
    200,
    "same-origin secret mutation succeeds",
  );
  if ((await stored.text()).includes(secret)) {
    throw new Error("Configuration response reflected a submitted secret.");
  }
  await expectStatus(
    await probe.mutate(
      "/api/studio/configuration/secrets/gemini-api-key",
      "DELETE",
      {},
    ),
    200,
    "temporary secret deletion succeeds",
  );

  console.log("Local Studio HTTP contract passed.");
} finally {
  server.kill("SIGTERM");
  await server.exited;
}
