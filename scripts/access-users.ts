#!/usr/bin/env bun
/**
 * Manage who may sign in to the hosted Frame of Mind deployment.
 *
 * Membership lives in one Cloudflare Access group that the app policy points
 * at, so adding or removing a tester never edits the policy itself.
 *
 *   bun scripts/access-users.ts list
 *   bun scripts/access-users.ts add someone@example.com [another@example.com]
 *   bun scripts/access-users.ts remove someone@example.com
 *   bun scripts/access-users.ts add-github <github-login>      # once GitHub login is enabled
 *
 * Configuration (never committed):
 *   CLOUDFLARE_API_TOKEN   token with Access: Organizations, Identity Providers, and Groups: Edit
 *   CLOUDFLARE_ACCOUNT_ID  account id
 *   FRAME_OF_MIND_ACCESS_GROUP_ID  the "Frame of Mind testers" group id
 * All three may also live in a file named by FRAME_OF_MIND_ACCESS_ENV (KEY=value lines).
 */
import { readFileSync } from "node:fs";

type Rule =
  | { email: { email: string } }
  | { github_organization: { name: string; identity_provider_id: string } }
  | { login_method: { id: string } }
  | Record<string, unknown>;

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
  if (!value) {
    console.error(`Missing ${key}.`);
    process.exit(2);
  }
  return value;
}

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
  if (!json.success) {
    console.error("Cloudflare API error:", JSON.stringify(json.errors));
    process.exit(1);
  }
  return json.result;
}

type Group = { name: string; include: Rule[] };

function emailOf(rule: Rule): string | undefined {
  return "email" in rule ? (rule as { email: { email: string } }).email.email.toLowerCase() : undefined;
}

function describe(rule: Rule): string {
  const email = emailOf(rule);
  if (email) return `email  ${email}`;
  if ("github_organization" in rule) {
    const r = (rule as { github_organization: { name: string; team?: string } }).github_organization;
    return `github ${r.name}${r.team ? `/${r.team}` : ""}`;
  }
  return `rule   ${Object.keys(rule)[0]}`;
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

const [command, ...args] = process.argv.slice(2);
const current = await api<Group>("GET");

switch (command) {
  case "list": {
    console.log(`${current.name} (${current.include.length} rule${current.include.length === 1 ? "" : "s"})`);
    for (const rule of current.include) console.log(`  ${describe(rule)}`);
    break;
  }
  case "add": {
    const emails = args.map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (!emails.length || !emails.every(validEmail)) {
      console.error("Usage: add <email> [email...]");
      process.exit(2);
    }
    const existing = new Set(current.include.map(emailOf).filter(Boolean));
    const additions = emails.filter((email) => !existing.has(email));
    if (!additions.length) {
      console.log("Nothing to add; all listed emails are already members.");
      break;
    }
    await api("PUT", {
      name: current.name,
      include: [...current.include, ...additions.map((email) => ({ email: { email } }))],
    });
    console.log(`Added ${additions.length}: ${additions.join(", ")}`);
    break;
  }
  case "remove": {
    const emails = args.map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (!emails.length) {
      console.error("Usage: remove <email> [email...]");
      process.exit(2);
    }
    const remaining = current.include.filter((rule) => {
      const email = emailOf(rule);
      return !email || !emails.includes(email);
    });
    if (remaining.length === current.include.length) {
      console.log("Nothing to remove; no listed email is a member.");
      break;
    }
    if (remaining.length === 0) {
      console.error("Refusing to remove the last member; the app would lock everyone out.");
      process.exit(1);
    }
    await api("PUT", { name: current.name, include: remaining });
    console.log(`Removed ${current.include.length - remaining.length}.`);
    break;
  }
  default:
    console.error("Usage: bun scripts/access-users.ts list | add <email...> | remove <email...>");
    process.exit(2);
}
