import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { createE2EEnvironment } from "./e2e-environment";
import { runFixture, videoRunFixture } from "../apps/web/test/fixtures";
import { analysisDigest } from "../src/domain/integrity";
import { createE2EIsolation } from "../apps/web/e2e/support/isolation";
import {
  betterAuthBrowserLogins,
  betterAuthFixtureVars,
  hostedAuthHeaders,
  hostedContractAuthMode,
  startFakeGithub,
} from "./hosted-auth-fixture";
import { resolvePrebuiltWebOutput } from "./prebuilt-artifact";
import {
  hostedAccessFetch,
  withHostedAccessTimeout,
} from "./hosted-access-timeout";

const isolation = await createE2EIsolation("hosted-access");
const temporaryRoot = isolation.root;
const persistRoot = isolation.persistRoot;
const configPath = join(temporaryRoot, "wrangler.jsonc");
const databaseName = isolation.databaseName;
const audience = "frame-of-mind-hosted-access-contract";
const keyId = "hosted-access-contract-key";
const accessScope = process.env.FRAME_OF_MIND_HOSTED_ACCESS_SCOPE || "full";
if (accessScope !== "full" && accessScope !== "required") {
  throw new Error("FRAME_OF_MIND_HOSTED_ACCESS_SCOPE must be 'full' or 'required'.");
}
const requiredAuthContract = accessScope === "required";
if (requiredAuthContract && hostedContractAuthMode !== "better-auth") {
  throw new Error("The required hosted-access scope supports only Better Auth.");
}
const entrySelection = process.env.FRAME_OF_MIND_HOSTED_ACCESS_ENTRY || "index";
if (entrySelection !== "index" && entrySelection !== "hosted-entry") {
  throw new Error("FRAME_OF_MIND_HOSTED_ACCESS_ENTRY must be 'index' or 'hosted-entry'.");
}
const entryFile = entrySelection === "hosted-entry" ? "hosted-entry.mjs" : "index.mjs";
const prebuiltOutput = await resolvePrebuiltWebOutput("cloudflare_module");
const webOutput = prebuiltOutput ?? resolve("apps/web/.output");
let wrangler: ReturnType<typeof Bun.spawn> | undefined;
let jwksServer: ReturnType<typeof Bun.serve> | undefined;
let fakeGithub: ReturnType<typeof startFakeGithub> | undefined;
let fakeMailer: ReturnType<typeof Bun.serve> | undefined;
const capturedAccessRequests: unknown[] = [];
let wranglerOutput: Promise<[string, string]> | undefined;
const requiredBetterAuthProfiles = [
  { id: "access-a", email: "access-a@example.test" },
  { id: "access-b", email: "access-b@example.test" },
  { id: "request-a", email: "request-a@example.test" },
];
const extendedBetterAuthProfiles = [
  { id: "request-b", email: "request-b@example.test" },
  { id: "request-c", email: "request-c@example.test" },
  { id: "request-d", email: "request-d@example.test" },
  { id: "request-e", email: "request-e@example.test" },
  { id: "request-f", email: "request-f@example.test" },
];
const betterAuthProfiles = requiredAuthContract
  ? requiredBetterAuthProfiles
  : [...requiredBetterAuthProfiles, ...extendedBetterAuthProfiles];

try {
  console.log("HOSTED_ACCESS build=START cloudflare_module");
  if (prebuiltOutput) {
    console.log("HOSTED_ACCESS build=SKIP prebuilt=cloudflare_module");
  } else {
    await runChecked(
      ["bun", "--no-env-file", "run", "build:web:cloudflare"],
      "Cloudflare artifact build",
    );
  }
  console.log("HOSTED_ACCESS build=PASS cloudflare_module");

  const keys = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(keys.publicKey);
  jwksServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/cdn-cgi/access/certs") {
        return new Response("not found", { status: 404 });
      }
      return Response.json({
        keys: [{ ...publicJwk, kid: keyId, alg: "RS256", use: "sig" }],
      });
    },
  });
  const issuer = `http://127.0.0.1:${jwksServer.port}`;
  const workerPort = await isolation.reservePort();
  const baseUrl = `http://127.0.0.1:${workerPort}`;
  fakeGithub = hostedContractAuthMode === "better-auth"
    ? startFakeGithub(betterAuthProfiles)
    : undefined;
  fakeMailer = hostedContractAuthMode === "better-auth" && !requiredAuthContract
    ? Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname !== "/access-request" || request.method !== "POST") {
            return new Response("not found", { status: 404 });
          }
          capturedAccessRequests.push(await request.json());
          return new Response(null, { status: 202 });
        },
      })
    : undefined;

  await writeFile(configPath, JSON.stringify({
    $schema: resolve("node_modules/wrangler/config-schema.json"),
    name: isolation.workerName(`hosted-access-${entryFile}`),
    main: join(webOutput, `server/${entryFile}`),
    compatibility_date: "2026-07-02",
    compatibility_flags: ["nodejs_compat", "nodejs_als"],
    assets: {
      directory: join(webOutput, "public"),
      binding: "ASSETS",
    },
    d1_databases: [{
      binding: "DB",
      database_name: databaseName,
      database_id: isolation.databaseId,
      migrations_dir: resolve("apps/web/db/migrations"),
    }],
    vars: hostedContractAuthMode === "better-auth"
      ? {
          ...betterAuthFixtureVars(baseUrl, fakeGithub!.origin),
          NUXT_MAINTAINER_EMAILS: " Access-A@Example.Test ",
          ...(!requiredAuthContract ? {
            NUXT_BETTER_AUTH_MAILER_ORIGIN: `http://127.0.0.1:${fakeMailer!.port}`,
            NUXT_BETTER_AUTH_MAILER_KEY: "fixture-mailer-key",
            NUXT_BETTER_AUTH_MAILER_FROM: "sign-in@example.test",
            NUXT_ACCESS_REQUEST_NOTIFY: "maintainer@example.test",
            NUXT_ACCESS_REQUEST_PENDING_CAP: "4",
          } : {}),
        }
      : {
          NUXT_AUTH_MODE: "cloudflare-access",
          NUXT_CLOUDFLARE_ACCESS_TEAM_DOMAIN: issuer,
          NUXT_CLOUDFLARE_ACCESS_AUD: audience,
          NUXT_CLOUDFLARE_ACCESS_ALLOW_INSECURE_TEST_JWKS: "true",
        },
  }, null, 2));

  const migrationArgs = [
    "bunx", "wrangler", "d1", "migrations", "apply",
    databaseName,
    "--local",
    "--config", configPath,
    "--persist-to", persistRoot,
  ];
  await runChecked(migrationArgs, "empty D1 principal migration");
  await runChecked(migrationArgs, "idempotent D1 migration replay");
  if (hostedContractAuthMode === "better-auth") {
    await runChecked([
      "bunx", "wrangler", "d1", "execute", databaseName,
      "--local", "--config", configPath, "--persist-to", persistRoot,
      "--command", "INSERT INTO hosted_auth_invites (email, invited_at) VALUES "
        + "('access-a@example.test','2026-08-23T00:00:00.000Z'),"
        + "('access-b@example.test','2026-08-23T00:00:00.000Z')",
    ], "Better Auth access-contract invites");
  }
  console.log("HOSTED_ACCESS migration=PASS empty_zero_sentinel replay_idempotent");

  const childEnvironment = createE2EEnvironment(process.env);
  wrangler = Bun.spawn([
    "bunx", "wrangler", "dev",
    "--local",
    "--config", configPath,
    "--persist-to", persistRoot,
    "--ip", "127.0.0.1",
    "--port", String(workerPort),
    "--log-level", "error",
    "--show-interactive-dev-session=false",
  ], {
    cwd: process.cwd(),
    env: childEnvironment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  wranglerOutput = Promise.all([
    new Response(wrangler.stdout).text(),
    new Response(wrangler.stderr).text(),
  ]);

  await waitForWorker(baseUrl, wrangler);

  const betterAuthLogins = hostedContractAuthMode === "better-auth"
    ? await betterAuthBrowserLogins(baseUrl, betterAuthProfiles.map(({ email }) => email))
    : undefined;
  const tokenA = hostedContractAuthMode === "better-auth"
    ? betterAuthLogins!.get("access-a@example.test")!
    : await signAccessToken(keys.privateKey, issuer, {
        sub: "hosted-user-subject-a",
        email: "recycled-seat@example.test",
      });
  const tokenB = hostedContractAuthMode === "better-auth"
    ? betterAuthLogins!.get("access-b@example.test")!
    : await signAccessToken(keys.privateKey, issuer, {
        sub: "hosted-user-subject-b",
        email: "recycled-seat@example.test",
      });
  const serviceToken = await signAccessToken(keys.privateKey, issuer, {
    sub: "",
    common_name: "hosted-contract.access",
  });

  if (hostedContractAuthMode === "better-auth") {
    const requestToken = betterAuthLogins!.get("request-a@example.test")!;
    const initialSession = await json<Record<string, unknown>>(
      await expectStatus(authenticatedFetch(baseUrl, "/api/session", requestToken), 200, "unapproved session"),
    );
    if ("accessState" in initialSession) throw new Error("Unknown principal already had membership state.");
    await expectUnapprovedBoundary(baseUrl, requestToken);

    const requestHeaders = {
      ...hostedAuthHeaders(requestToken, baseUrl),
      "cf-connecting-ip": "198.51.100.70",
    };
    const requested = await json<Record<string, unknown>>(await expectStatus(fetch(
      `${baseUrl}/api/access/request`,
      { method: "POST", headers: requestHeaders, body: "{}" },
    ), 200, "create access request"));
    assertEqual(requested, {
      state: "requested",
      created: true,
      notificationSent: !requiredAuthContract,
    }, "created access request");
    await expectStatus(fetch(`${baseUrl}/api/access/request`, {
      method: "POST",
      headers: requestHeaders,
      body: "{}",
    }), 200, "idempotent access request");
    const requestedSession = await json<Record<string, unknown>>(
      await expectStatus(authenticatedFetch(baseUrl, "/api/session", requestToken), 200, "requested session"),
    );
    assertEqual(requestedSession.accessState, "requested", "requested membership state");
    await expectUnapprovedBoundary(baseUrl, requestToken);
    if (requiredAuthContract) {
      assertEqual(capturedAccessRequests.length, 0, "required contract sends no email");
      console.log("HOSTED_AUTH_REQUIRED request_access=PASS session=requested protected=403 admin=dark mail=disabled");
    } else {
      assertEqual(capturedAccessRequests.length, 1, "one maintainer notification per principal");
      assertEqual(capturedAccessRequests[0], {
        notifyEmail: "maintainer@example.test",
        requesterEmail: "request-a@example.test",
        command: "bun run approve 'request-a@example.test'",
      }, "maintainer notification contract");
      await expectStatus(fetch(`${baseUrl}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: {
          origin: baseUrl,
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.70",
        },
        body: JSON.stringify({
          email: "request-a@example.test",
          name: "Request A",
          callbackURL: "/api/session",
        }),
      }), 403, "requested account magic-link denial");
      assertEqual(capturedAccessRequests.length, 1, "no requester email after access request");

      for (const email of ["request-b@example.test", "request-c@example.test"]) {
        await expectStatus(fetch(`${baseUrl}/api/access/request`, {
          method: "POST",
          headers: {
            ...hostedAuthHeaders(betterAuthLogins!.get(email)!, baseUrl),
            "cf-connecting-ip": "198.51.100.70",
          },
          body: "{}",
        }), 200, `per-IP request ${email}`);
      }
      await expectStatus(fetch(`${baseUrl}/api/access/request`, {
        method: "POST",
        headers: {
          ...hostedAuthHeaders(betterAuthLogins!.get("request-d@example.test")!, baseUrl),
          "cf-connecting-ip": "198.51.100.70",
        },
        body: "{}",
      }), 429, "per-IP access-request rate limit");
      await expectStatus(fetch(`${baseUrl}/api/access/request`, {
        method: "POST",
        headers: {
          ...hostedAuthHeaders(betterAuthLogins!.get("request-e@example.test")!, baseUrl),
          "cf-connecting-ip": "198.51.100.71",
        },
        body: "{}",
      }), 200, "final pending access-request slot");
      const capacityLimited = await expectStatus(fetch(`${baseUrl}/api/access/request`, {
        method: "POST",
        headers: {
          ...hostedAuthHeaders(betterAuthLogins!.get("request-f@example.test")!, baseUrl),
          "cf-connecting-ip": "198.51.100.72",
        },
        body: "{}",
      }), 429, "pending access-request capacity");
      if (!(await responseText(capacityLimited, "pending access-request capacity body"))
        .includes("access_request_capacity_reached")) {
        throw new Error("Pending access-request capacity omitted its stable code.");
      }
      await verifyAdminAccessSurface({
        baseUrl,
        maintainerToken: tokenA,
        nonMaintainerToken: tokenB,
        capturedAccessRequests,
      });
      console.log("HOSTED_ACCESS request_access=PASS session=requested protected=403 mail=maintainer_only rate_limit=429 pending_cap=429");
    }
  }

  await expectStatus(fetch(`${baseUrl}/api/runs`), 403, "missing Access assertion");
  if (hostedContractAuthMode === "cloudflare-access") {
    await expectStatus(authenticatedFetch(baseUrl, "/api/runs", serviceToken), 403, "service principal browser denial");
  }

  const runA = runFixture();
  runA.analysis.runId = "20260822T120001Z-principal-a";
  runA.manifest.runId = runA.analysis.runId;
  runA.manifest.analysisSha256 = await analysisDigest(runA.analysis);
  const runB = await videoRunFixture();
  runB.analysis.runId = "20260822T120002Z-principal-b";
  runB.manifest.runId = runB.analysis.runId;
  runB.manifest.analysisSha256 = await analysisDigest(runB.analysis);

  await expectStatus(importRun(baseUrl, tokenA, runA), 201, "principal A import");
  await expectStatus(importRun(baseUrl, tokenB, runB), 201, "principal B import");

  const listA = await json<{ runs: Array<{ runId: string }> }>(
    await expectStatus(authenticatedFetch(baseUrl, "/api/runs", tokenA), 200, "principal A list"),
  );
  const listB = await json<{ runs: Array<{ runId: string }> }>(
    await expectStatus(authenticatedFetch(baseUrl, "/api/runs", tokenB), 200, "principal B list"),
  );
  assertEqual(listA.runs.map((run) => run.runId), [runA.manifest.runId], "principal A list isolation");
  assertEqual(listB.runs.map((run) => run.runId), [runB.manifest.runId], "principal B list isolation");

  await expectStatus(
    authenticatedFetch(baseUrl, `/api/runs/${runB.manifest.runId}`, tokenA),
    404,
    "principal A detail denial",
  );
  await expectStatus(
    authenticatedFetch(baseUrl, `/api/runs/${runA.manifest.runId}`, tokenB),
    404,
    "principal B detail denial",
  );

  const conflicting = structuredClone(runA);
  const conflictResponse = await expectStatus(
    importRun(baseUrl, tokenB, conflicting),
    409,
    "cross-principal run ID conflict",
  );
  const conflictText = await responseText(conflictResponse, "cross-principal conflict body");
  if (!conflictText.includes("run_principal_conflict")) {
    throw new Error("Cross-principal conflict omitted run_principal_conflict.");
  }

  const session = await json<Record<string, unknown>>(
    await expectStatus(authenticatedFetch(baseUrl, "/api/session", tokenA), 200, "display session"),
  );
  if (
    "sub" in session
    || (hostedContractAuthMode === "better-auth"
      ? session.principal !== true
      : "principal" in session)
  ) {
    throw new Error("GET /api/session exposed the durable principal.");
  }
  await expectStatus(
    authenticatedFetch(baseUrl, "/api/hosted/jobs", tokenA),
    404,
    "hosted creation remains dark",
  );
  if (requiredAuthContract) {
    await verifyRequiredAuthRevocation(baseUrl, tokenA, tokenB);
  }

  console.log(`HOSTED_ACCESS principal_a=PASS own=${runA.manifest.runId} foreign_detail=404`);
  console.log(`HOSTED_ACCESS principal_b=PASS own=${runB.manifest.runId} foreign_detail=404`);
  console.log("HOSTED_ACCESS conflict=PASS status=409 code=run_principal_conflict");
  console.log(hostedContractAuthMode === "cloudflare-access"
    ? "HOSTED_ACCESS service=PASS status=403 browser_runs_denied"
    : "HOSTED_ACCESS service=PASS not_applicable=better_auth");
  console.log("HOSTED_ACCESS missing_header=PASS status=403");
  console.log("HOSTED_ACCESS dark=PASS hosted_creation_status=404");

  await stopWrangler(wrangler, wranglerOutput);
  wrangler = undefined;
  wranglerOutput = undefined;
  if (requiredAuthContract) {
    await verifyRequiredPrincipalMapping();
    console.log("HOSTED_AUTH_REQUIRED principal=PASS prefix=ba ownership=isolated revocation=next_request");
  } else if (hostedContractAuthMode === "better-auth") {
    await verifyMaintainerCommands();
    console.log("HOSTED_ACCESS maintainer_cli=PASS approve_alias=true deny=true remove=revoked list_requests=true");
  }
  console.log(requiredAuthContract
    ? `HOSTED_AUTH_REQUIRED_CONTRACT PASSED entry=${entryFile}`
    : `HOSTED_ACCESS_CONTRACT PASSED entry=${entryFile}`);
} catch (error) {
  if (wrangler) {
    try {
      await stopWrangler(wrangler, wranglerOutput, true);
    } catch (cleanupError) {
      wrangler.kill("SIGKILL");
      process.stderr.write(`${String(cleanupError)}\n`);
    }
  }
  throw error;
} finally {
  jwksServer?.stop(true);
  fakeGithub?.stop();
  fakeMailer?.stop(true);
  await isolation.cleanup();
}

async function verifyRequiredAuthRevocation(
  baseUrl: string,
  maintainerToken: string,
  memberToken: string,
): Promise<void> {
  const unknownApi = await hostedAccessFetch(
    "required non-maintainer unknown GET",
    `${baseUrl}/api/route-that-does-not-exist`,
    { headers: hostedAuthHeaders(memberToken) },
  );
  const hiddenApi = await hostedAccessFetch(
    "required non-maintainer admin GET",
    `${baseUrl}/api/admin/access`,
    { headers: hostedAuthHeaders(memberToken) },
  );
  await assertMatchingNotFoundShape(unknownApi, hiddenApi, "required admin darkness");

  const maintainerSession = await json<Record<string, unknown>>(await expectStatus(
    authenticatedFetch(baseUrl, "/api/session", maintainerToken),
    200,
    "required maintainer session",
  ));
  assertEqual(maintainerSession.maintainer, true, "required maintainer capability");
  const revoked = await adminAction(
    baseUrl,
    maintainerToken,
    "revoke",
    "access-b@example.test",
  );
  assertEqual(revoked.state, "revoked", "required member revocation");
  await expectStatus(
    authenticatedFetch(baseUrl, "/api/runs", memberToken),
    403,
    "revocation observed on next request",
  );
  const revokedSession = await json<Record<string, unknown>>(await expectStatus(
    authenticatedFetch(baseUrl, "/api/session", memberToken),
    200,
    "revoked session status",
  ));
  assertEqual(revokedSession.accessState, "revoked", "revoked membership state");
}

async function verifyRequiredPrincipalMapping(): Promise<void> {
  const rowsJson = await runChecked([
    "bunx", "wrangler", "d1", "execute", databaseName,
    "--local", "--config", configPath, "--persist-to", persistRoot,
    "--command", "SELECT u.email, u.id AS user_id, r.principal_sub "
      + "FROM better_auth_user u JOIN analysis_run_registry r "
      + "ON r.principal_sub = 'ba:' || u.id "
      + "WHERE u.email IN ('access-a@example.test','access-b@example.test') "
      + "ORDER BY u.email",
    "--json",
  ], "required principal mapping query");
  const resultSets = JSON.parse(rowsJson) as Array<{
    results?: Array<{ email?: string; user_id?: string; principal_sub?: string }>;
  }>;
  const rows = resultSets.flatMap(({ results }) => results ?? []);
  assertEqual(rows.length, 2, "required principal mapping row count");
  for (const row of rows) {
    if (!row.user_id || row.principal_sub !== `ba:${row.user_id}`) {
      throw new Error(`Required principal mapping was invalid for ${row.email ?? "unknown"}.`);
    }
  }
}

async function verifyAdminAccessSurface(input: {
  baseUrl: string;
  maintainerToken: string;
  nonMaintainerToken: string;
  capturedAccessRequests: unknown[];
}): Promise<void> {
  const unknownApi = await hostedAccessFetch(
    "http non-maintainer unknown GET",
    `${input.baseUrl}/api/route-that-does-not-exist`,
    { headers: hostedAuthHeaders(input.nonMaintainerToken) },
  );
  const hiddenApi = await hostedAccessFetch(
    "http non-maintainer admin GET",
    `${input.baseUrl}/api/admin/access`,
    { headers: hostedAuthHeaders(input.nonMaintainerToken) },
  );
  await assertMatchingNotFoundShape(unknownApi, hiddenApi, "non-maintainer admin GET");

  const unknownPost = await hostedAccessFetch(
    "http non-maintainer unknown POST",
    `${input.baseUrl}/api/route-that-does-not-exist`,
    {
      method: "POST",
      headers: adminMutationHeaders(input.nonMaintainerToken, input.baseUrl),
      body: "{}",
    },
  );
  const hiddenPost = await hostedAccessFetch(
    "http non-maintainer admin POST",
    `${input.baseUrl}/api/admin/access/approve`,
    {
      method: "POST",
      headers: adminMutationHeaders(input.nonMaintainerToken, input.baseUrl),
      body: JSON.stringify({ email: "request-a@example.test" }),
    },
  );
  await assertMatchingNotFoundShape(unknownPost, hiddenPost, "non-maintainer admin POST");

  const unknownHtml = await hostedAccessFetch(
    "http non-maintainer unknown HTML",
    `${input.baseUrl}/route-that-does-not-exist`,
    { headers: { ...hostedAuthHeaders(input.nonMaintainerToken), accept: "text/html" } },
  );
  const hiddenHtml = await hostedAccessFetch(
    "http non-maintainer admin HTML",
    `${input.baseUrl}/admin/access`,
    { headers: { ...hostedAuthHeaders(input.nonMaintainerToken), accept: "text/html" } },
  );
  await assertMatchingNotFoundShape(unknownHtml, hiddenHtml, "non-maintainer admin page");

  const maintainerSession = await json<Record<string, unknown>>(await expectStatus(
    authenticatedFetch(input.baseUrl, "/api/session", input.maintainerToken),
    200,
    "maintainer session",
  ));
  assertEqual(maintainerSession.maintainer, true, "allowlisted session maintainer flag");
  const nonMaintainerSession = await json<Record<string, unknown>>(await expectStatus(
    authenticatedFetch(input.baseUrl, "/api/session", input.nonMaintainerToken),
    200,
    "non-maintainer session",
  ));
  if ("maintainer" in nonMaintainerSession) {
    throw new Error("Non-maintainer session exposed a maintainer flag.");
  }

  await expectStatus(fetch(`${input.baseUrl}/admin/access`, {
    headers: { ...hostedAuthHeaders(input.maintainerToken), accept: "text/html" },
  }), 200, "maintainer admin page");
  const initial = await json<{
    requested: Array<{ email: string }>;
    approved: Array<{ email: string }>;
    revoked: Array<{ email: string }>;
  }>(await expectStatus(
    authenticatedFetch(input.baseUrl, "/api/admin/access", input.maintainerToken),
    200,
    "maintainer access list",
  ));
  for (const [group, email] of [
    [initial.requested, "request-a@example.test"],
    [initial.approved, "access-a@example.test"],
  ] as const) {
    if (!group.some((row) => row.email === email)) {
      throw new Error(`Admin access list omitted ${email}.`);
    }
  }

  const mailCount = input.capturedAccessRequests.length;
  const approve = await adminAction(
    input.baseUrl,
    input.maintainerToken,
    "approve",
    "request-a@example.test",
  );
  assertEqual(approve, {
    email: "request-a@example.test",
    state: "approved",
    idempotent: false,
  }, "admin approve");
  const approveReplay = await adminAction(
    input.baseUrl,
    input.maintainerToken,
    "approve",
    "request-a@example.test",
  );
  assertEqual(approveReplay.idempotent, true, "admin approve replay");

  const deny = await adminAction(
    input.baseUrl,
    input.maintainerToken,
    "deny",
    "request-b@example.test",
  );
  assertEqual(deny.state, "revoked", "admin deny");
  const denyReplay = await adminAction(
    input.baseUrl,
    input.maintainerToken,
    "deny",
    "request-b@example.test",
  );
  assertEqual(denyReplay.idempotent, true, "admin deny replay");

  const revoke = await adminAction(
    input.baseUrl,
    input.maintainerToken,
    "revoke",
    "access-b@example.test",
  );
  assertEqual(revoke.state, "revoked", "admin revoke");
  const revokeReplay = await adminAction(
    input.baseUrl,
    input.maintainerToken,
    "revoke",
    "access-b@example.test",
  );
  assertEqual(revokeReplay.idempotent, true, "admin revoke replay");
  await adminAction(input.baseUrl, input.maintainerToken, "approve", "access-b@example.test");
  assertEqual(input.capturedAccessRequests.length, mailCount, "admin actions send no email");

  const audit = await runChecked([
    "bunx", "wrangler", "d1", "execute", databaseName,
    "--local", "--config", configPath, "--persist-to", persistRoot,
    "--command", "SELECT actioned_by, actioned_at FROM hosted_auth_invites "
      + "WHERE email = 'request-a@example.test'",
    "--json",
  ], "admin action audit query");
  if (!audit.includes("access-a@example.test") || !audit.includes("2026-")) {
    throw new Error(`Admin audit row omitted maintainer or timestamp: ${audit}`);
  }
  console.log("HOSTED_ACCESS admin=PASS dark_404=true list=true approve=true deny=true revoke=true replay=true mail=false");
}

async function adminAction(
  origin: string,
  token: string,
  action: "approve" | "deny" | "revoke",
  email: string,
): Promise<Record<string, unknown>> {
  return await json(await expectStatus(fetch(`${origin}/api/admin/access/${action}`, {
    method: "POST",
    headers: adminMutationHeaders(token, origin),
    body: JSON.stringify({ email }),
  }), 200, `admin ${action} ${email}`));
}

function adminMutationHeaders(token: string, origin: string): Record<string, string> {
  return {
    ...hostedAuthHeaders(token, origin),
    "sec-fetch-site": "same-origin",
  };
}

async function assertMatchingNotFoundShape(
  unknown: Response,
  hidden: Response,
  label: string,
): Promise<void> {
  if (unknown.status !== 404 || hidden.status !== 404) {
    throw new Error(`${label}: expected matching 404 responses, received ${unknown.status}/${hidden.status}.`);
  }
  const unknownType = unknown.headers.get("content-type")?.split(";", 1)[0];
  const hiddenType = hidden.headers.get("content-type")?.split(";", 1)[0];
  if (unknownType !== hiddenType) {
    throw new Error(`${label}: content types differ (${unknownType}/${hiddenType}).`);
  }
  const [unknownBody, hiddenBody] = await withHostedAccessTimeout(
    `response_body ${label}`,
    () => Promise.all([unknown.text(), hidden.text()]),
  );
  if (unknownType === "application/json") {
    const unknownKeys = Object.keys(JSON.parse(unknownBody)).sort();
    const hiddenKeys = Object.keys(JSON.parse(hiddenBody)).sort();
    assertEqual(hiddenKeys, unknownKeys, `${label} JSON shape`);
  } else if (!unknownBody.includes("404") || !hiddenBody.includes("404")) {
    throw new Error(`${label}: HTML responses were not both 404 pages.`);
  }
}

async function expectUnapprovedBoundary(origin: string, token: string): Promise<void> {
  await expectStatus(authenticatedFetch(origin, "/api/runs", token), 403, "unapproved runs denial");
  await expectStatus(authenticatedFetch(origin, "/api/hosted/configuration", token), 403, "unapproved hosted denial");
  for (const path of ["/api/hosted/media", "/api/hosted/composer/jobs"]) {
    await expectStatus(fetch(`${origin}${path}`, {
      method: "POST",
      headers: hostedAuthHeaders(token, origin),
      body: "{}",
    }), 403, `unapproved mutation denial ${path}`);
  }

  await expectStatus(hostedAccessFetch(
    "unapproved hidden admin GET",
    `${origin}/api/admin/access`,
    { headers: hostedAuthHeaders(token) },
  ), 404, "unapproved admin GET darkness");

  await expectStatus(hostedAccessFetch(
    "unapproved hidden admin POST",
    `${origin}/api/admin/access/approve`,
    {
      method: "POST",
      headers: adminMutationHeaders(token, origin),
      body: JSON.stringify({ email: "access-a@example.test" }),
    },
  ), 404, "unapproved admin POST darkness");

  await expectStatus(hostedAccessFetch(
    "unapproved hidden admin HTML",
    `${origin}/admin/access`,
    { headers: { ...hostedAuthHeaders(token), accept: "text/html" } },
  ), 404, "unapproved admin page darkness");
}

async function verifyMaintainerCommands(): Promise<void> {
  const commandEnvironment = {
    FRAME_OF_MIND_D1_DATABASE: databaseName,
    FRAME_OF_MIND_D1_LOCAL: "1",
    FRAME_OF_MIND_D1_PERSIST_TO: persistRoot,
    FRAME_OF_MIND_WRANGLER_CONFIG: configPath,
    FRAME_OF_MIND_ACCESS_DECIDED_BY: "fixture-operator",
  };
  await runChecked(
    ["bun", "run", "approve", "request-a@example.test"],
    "approve package alias",
    commandEnvironment,
  );
  await runChecked(
    ["bun", "scripts/studio-users.ts", "--mode", "better-auth", "deny", "request-b@example.test"],
    "deny request command",
    commandEnvironment,
  );
  await runChecked(
    ["bun", "scripts/studio-users.ts", "--mode", "better-auth", "remove", "access-a@example.test"],
    "remove member command",
    commandEnvironment,
  );
  await runChecked(
    ["bun", "scripts/studio-users.ts", "--mode", "better-auth", "add", "preapproved@example.test"],
    "pre-approve member command",
    commandEnvironment,
  );
  const requests = await runChecked(
    ["bun", "scripts/studio-users.ts", "--mode", "better-auth", "list-requests"],
    "list requests command",
    commandEnvironment,
  );
  if (!requests.includes("request-c@example.test") || requests.includes("request-a@example.test")) {
    throw new Error(`Maintainer request list had the wrong state: ${requests}`);
  }
  const rows = await runChecked([
    "bunx", "wrangler", "d1", "execute", databaseName,
    "--local", "--config", configPath, "--persist-to", persistRoot,
    "--command", "SELECT email, state, decided_by, actioned_by, actioned_at FROM hosted_auth_invites "
      + "WHERE email IN ('request-a@example.test','request-b@example.test',"
      + "'access-a@example.test','preapproved@example.test') ORDER BY email",
    "--json",
  ], "maintainer command state query");
  for (const expected of [
    "request-a@example.test",
    "request-b@example.test",
    "access-a@example.test",
    "preapproved@example.test",
    "approved",
    "revoked",
    "fixture-operator",
    "cli",
  ]) {
    if (!rows.includes(expected)) throw new Error(`Maintainer state query omitted ${expected}: ${rows}`);
  }
}

async function signAccessToken(
  privateKey: KeyLike,
  issuer: string,
  claims: Record<string, unknown>,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function authenticatedFetch(origin: string, path: string, token: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: hostedAuthHeaders(token),
  });
}

function importRun(origin: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${origin}/api/runs`, {
    method: "POST",
    headers: hostedAuthHeaders(token, origin),
    body: JSON.stringify(body),
  });
}

async function expectStatus(
  responsePromise: Promise<Response> | Response,
  expected: number,
  label: string,
): Promise<Response> {
  const response = await withHostedAccessTimeout(
    `http ${label}`,
    () => Promise.resolve(responsePromise),
  );
  if (response.status !== expected) {
    throw new Error(
      `${label}: expected HTTP ${expected}, received ${response.status}: ${await responseText(response, `${label} error body`)}`,
    );
  }
  return response;
}

async function json<T>(response: Response): Promise<T> {
  return await withHostedAccessTimeout(
    "response_body json",
    () => response.json() as Promise<T>,
  );
}

async function responseText(response: Response, label: string): Promise<string> {
  return await withHostedAccessTimeout(
    `response_body ${label}`,
    () => response.text(),
  );
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

async function runChecked(
  command: string[],
  label: string,
  additions: Record<string, string> = {},
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    env: createE2EEnvironment(process.env, additions),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await withHostedAccessTimeout(
    `command ${label}`,
    (signal) => {
      signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
      return Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
    },
    60_000,
  );
  if (exitCode !== 0) {
    throw new Error(`${label} failed (${exitCode}):\n${stdout}\n${stderr}`.slice(0, 12_000));
  }
  return stdout;
}

async function waitForWorker(
  origin: string,
  child: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await hostedAccessFetch(
        "worker_ready health_probe",
        `${origin}/api/health`,
        { redirect: "manual" },
      );
      if (response.status === 403) return;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("hosted_access_timeout:")) {
        throw error;
      }
      // workerd is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error("hosted_access_timeout: worker_ready health_probe");
}

async function stopWrangler(
  child: ReturnType<typeof Bun.spawn>,
  output: Promise<[string, string]> | undefined,
  reportOutput = false,
): Promise<void> {
  child.kill("SIGTERM");
  await withHostedAccessTimeout(
    "wrangler_exit",
    () => child.exited.then(() => undefined),
  );
  if (output) {
    const [stdout, stderr] = await withHostedAccessTimeout(
      "wrangler_output",
      () => output,
    );
    if (reportOutput || (child.exitCode && child.exitCode !== 0)) {
      process.stderr.write(`Hosted Access workerd output:\n${stdout}\n${stderr}`.slice(0, 12_000));
    }
  }
}
