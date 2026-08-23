#!/usr/bin/env bun
/** Manage hosted Studio membership in Access or Better Auth mode. */
import { readFileSync } from "node:fs";

type Rule =
  | { email: { email: string } }
  | { github_organization: { name: string; identity_provider_id: string } }
  | { login_method: { id: string } }
  | Record<string, unknown>;

type MembershipMode = "cloudflare-access" | "better-auth";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  const file = process.env.FRAME_OF_MIND_ACCESS_ENV;
  if (file) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && !env[match[1]]) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

function required(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing ${key}.`);
  return value;
}

function validEmail(value: string): boolean {
  return /^[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)
    && value.length <= 320;
}

function emails(args: string[]): string[] {
  const values = [...new Set(args.map((value) => value.trim().toLowerCase()).filter(Boolean))];
  if (!values.length || !values.every(validEmail)) throw new Error("Provide one or more valid email addresses.");
  return values;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseArguments(args: string[], fallbackMode?: MembershipMode): {
  mode: MembershipMode;
  command: string;
  values: string[];
} {
  const remaining = [...args];
  let selected = fallbackMode || process.env.FRAME_OF_MIND_AUTH_MODE || "cloudflare-access";
  if (remaining[0] === "--mode") {
    remaining.shift();
    selected = remaining.shift() || "";
  }
  if (selected === "cloudflare-access+better-auth") selected = "better-auth";
  if (selected !== "cloudflare-access" && selected !== "better-auth") {
    throw new Error("--mode must be cloudflare-access or better-auth.");
  }
  return {
    mode: selected,
    command: remaining.shift() || "",
    values: remaining,
  };
}

export async function main(args = process.argv.slice(2), fallbackMode?: MembershipMode): Promise<void> {
  const { mode, command, values } = parseArguments(args, fallbackMode);
  if (!(["list", "add", "remove"].includes(command))) {
    throw new Error(
      "Usage: bun scripts/studio-users.ts [--mode cloudflare-access|better-auth] "
      + "list | add <email...> | remove <email...>",
    );
  }
  if (mode === "better-auth") {
    await manageBetterAuth(command, values);
  } else {
    await manageAccess(command, values);
  }
}

async function manageBetterAuth(command: string, values: string[]): Promise<void> {
  const env = loadEnv();
  const database = env.FRAME_OF_MIND_D1_DATABASE || "frame-of-mind";
  const config = env.FRAME_OF_MIND_WRANGLER_CONFIG || "apps/web/wrangler.jsonc";
  const target = env.FRAME_OF_MIND_D1_LOCAL === "1" ? "--local" : "--remote";
  let statement: string;
  if (command === "list") {
    statement = "SELECT email, claimed_user_id IS NOT NULL AS claimed, invited_at, claimed_at "
      + "FROM hosted_auth_invites ORDER BY email";
  } else if (command === "add") {
    const now = new Date().toISOString();
    statement = emails(values).map((email) =>
      "INSERT OR IGNORE INTO hosted_auth_invites (email, invited_at) VALUES "
      + `(${sqlLiteral(email)}, ${sqlLiteral(now)})`,
    ).join("; ");
  } else {
    const targets = emails(values).map(sqlLiteral).join(", ");
    const current = await executeBetterAuthD1Json(
      database,
      target,
      config,
      "SELECT email FROM hosted_auth_invites ORDER BY email",
    );
    const requested = new Set(emails(values));
    const members = current
      .map((row) => typeof row.email === "string" ? row.email.toLowerCase() : "")
      .filter(Boolean);
    const removed = members.filter((email) => requested.has(email));
    if (!removed.length) {
      console.log("Nothing to remove; no listed email is a member.");
      return;
    }
    if (removed.length === members.length) {
      throw new Error("Refusing to remove the last member; the app would lock everyone out.");
    }
    const deleted = await executeBetterAuthD1Json(
      database,
      target,
      config,
      `DELETE FROM hosted_auth_invites WHERE email IN (${targets}) `
      + `AND EXISTS (SELECT 1 FROM hosted_auth_invites WHERE email NOT IN (${targets})) RETURNING email`,
    );
    if (deleted.length !== removed.length) {
      throw new Error("Membership changed concurrently; removal was not fully applied. Retry the command.");
    }
    console.log(`Removed ${deleted.length}.`);
    return;
  }
  const child = Bun.spawn([
    "bunx", "wrangler", "d1", "execute", database,
    target,
    "--config", config,
    "--command", statement,
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Wrangler D1 membership command failed (${code}).`);
}

async function executeBetterAuthD1Json(
  database: string,
  target: "--local" | "--remote",
  config: string,
  statement: string,
): Promise<Array<Record<string, unknown>>> {
  const child = Bun.spawn([
    "bunx", "wrangler", "d1", "execute", database,
    target,
    "--config", config,
    "--command", statement,
    "--json",
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`Wrangler D1 membership command failed (${code}): ${stderr.trim()}`);
  const batches = JSON.parse(stdout) as Array<{
    results?: Array<Record<string, unknown>>;
    success?: boolean;
  }>;
  if (!Array.isArray(batches) || batches.some((batch) => batch.success === false)) {
    throw new Error("Wrangler D1 membership command returned an invalid result.");
  }
  return batches.flatMap((batch) => batch.results ?? []);
}

async function manageAccess(command: string, values: string[]): Promise<void> {
  const env = loadEnv();
  const token = required(env, "CLOUDFLARE_API_TOKEN");
  const account = required(env, "CLOUDFLARE_ACCOUNT_ID");
  const group = required(env, "FRAME_OF_MIND_ACCESS_GROUP_ID");
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/access/groups/${group}`;

  async function api<T>(method: string, body?: unknown): Promise<T> {
    const response = await fetch(base, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json() as { success: boolean; result: T; errors: unknown[] };
    if (!json.success) throw new Error(`Cloudflare API error: ${JSON.stringify(json.errors)}`);
    return json.result;
  }

  type Group = { name: string; include: Rule[] };
  const emailOf = (rule: Rule): string | undefined =>
    "email" in rule ? (rule as { email: { email: string } }).email.email.toLowerCase() : undefined;
  const describe = (rule: Rule): string => {
    const email = emailOf(rule);
    if (email) return `email  ${email}`;
    if ("github_organization" in rule) {
      const value = (rule as { github_organization: { name: string; team?: string } }).github_organization;
      return `github ${value.name}${value.team ? `/${value.team}` : ""}`;
    }
    return `rule   ${Object.keys(rule)[0]}`;
  };
  const current = await api<Group>("GET");
  if (command === "list") {
    console.log(`${current.name} (${current.include.length} rule${current.include.length === 1 ? "" : "s"})`);
    for (const rule of current.include) console.log(`  ${describe(rule)}`);
    return;
  }
  const requested = emails(values);
  if (command === "add") {
    const existing = new Set(current.include.map(emailOf).filter(Boolean));
    const additions = requested.filter((email) => !existing.has(email));
    if (!additions.length) {
      console.log("Nothing to add; all listed emails are already members.");
      return;
    }
    await api("PUT", {
      name: current.name,
      include: [...current.include, ...additions.map((email) => ({ email: { email } }))],
    });
    console.log(`Added ${additions.length}: ${additions.join(", ")}`);
    return;
  }
  const remaining = current.include.filter((rule) => {
    const email = emailOf(rule);
    return !email || !requested.includes(email);
  });
  if (remaining.length === current.include.length) {
    console.log("Nothing to remove; no listed email is a member.");
    return;
  }
  if (remaining.length === 0) throw new Error("Refusing to remove the last member; the app would lock everyone out.");
  await api("PUT", { name: current.name, include: remaining });
  console.log(`Removed ${current.include.length - remaining.length}.`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
