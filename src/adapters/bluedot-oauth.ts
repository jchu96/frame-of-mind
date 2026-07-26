import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

interface StoredOAuth {
  resource?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

export function configRoot(): string {
  const configured = process.env.XDG_CONFIG_HOME;
  return configured && isAbsolute(configured) ? configured : join(homedir(), ".config");
}

export const DEFAULT_TOKEN_PATH = join(configRoot(), "frame-of-mind", "bluedot-oauth.json");
export const DEFAULT_GRANOLA_TOKEN_PATH = join(configRoot(), "frame-of-mind", "granola-oauth.json");

export interface McpEndpoint {
  url: URL;
  tokenPath: string;
  canonical: boolean;
}

export function resolveMcpEndpoint(
  provider: "bluedot" | "granola",
  configuredUrl: string | undefined,
  defaultUrl: string,
  defaultTokenPath: string,
): McpEndpoint {
  const url = new URL(configuredUrl || defaultUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${provider} MCP endpoint must be an HTTPS URL without embedded credentials.`);
  }
  const canonical = url.toString() === new URL(defaultUrl).toString();
  const suffix = createHash("sha256").update(url.toString()).digest("hex").slice(0, 16);
  return {
    url,
    tokenPath: canonical
      ? defaultTokenPath
      : join(dirname(defaultTokenPath), `${provider}-oauth-${suffix}.json`),
    canonical,
  };
}

export class FileOAuthProvider implements OAuthClientProvider {
  readonly clientMetadata: OAuthClientMetadata;
  readonly redirectUrl: string;
  private stored: StoredOAuth;

  constructor(
    redirectUrl: string,
    private readonly tokenPath: string,
    private readonly onRedirect: (url: URL) => void,
    private readonly oauthState = randomUUID(),
    private readonly resource?: string,
    private readonly allowLegacyUnscoped = false,
  ) {
    this.redirectUrl = redirectUrl;
    this.clientMetadata = {
      client_name: "Frame of Mind",
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };
    try {
      const stored = JSON.parse(readFileSync(tokenPath, "utf8")) as StoredOAuth;
      this.stored = stored.resource === resource || (!stored.resource && allowLegacyUnscoped)
        ? { ...stored, ...(resource ? { resource } : {}) }
        : { ...(resource ? { resource } : {}) };
    } catch {
      this.stored = { ...(resource ? { resource } : {}) };
    }
  }

  state(): string {
    return this.oauthState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.stored.clientInformation;
  }

  saveClientInformation(value: OAuthClientInformationMixed): void {
    this.stored.clientInformation = value;
    this.persist();
  }

  tokens(): OAuthTokens | undefined {
    return this.stored.tokens;
  }

  saveTokens(value: OAuthTokens): void {
    this.stored.tokens = value;
    this.persist();
  }

  redirectToAuthorization(url: URL): void {
    this.onRedirect(url);
  }

  saveCodeVerifier(value: string): void {
    this.stored.codeVerifier = value;
    this.persist();
  }

  codeVerifier(): string {
    if (!this.stored.codeVerifier) throw new Error("OAuth code verifier is missing.");
    return this.stored.codeVerifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") {
      this.stored = { ...(this.resource ? { resource: this.resource } : {}) };
    } else if (scope === "client") {
      delete this.stored.clientInformation;
    } else if (scope === "tokens") {
      delete this.stored.tokens;
    } else if (scope === "verifier") {
      delete this.stored.codeVerifier;
    }
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.tokenPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.tokenPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.stored, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, this.tokenPath);
    chmodSync(this.tokenPath, 0o600);
  }
}

export class OAuthCallback {
  private server?: Server;
  private resolveCode?: (code: string) => void;
  private rejectCode?: (error: Error) => void;
  readonly code: Promise<string>;
  readonly state = randomUUID();
  private timeout?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly port: number,
    private readonly providerName = "Meeting provider",
  ) {
    this.code = new Promise<string>((resolve, reject) => {
      this.resolveCode = resolve;
      this.rejectCode = reject;
    });
  }

  async listen(): Promise<void> {
    this.server = createServer((request, response) => {
      const url = new URL(request.url || "/", `http://127.0.0.1:${this.port}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (url.pathname !== "/callback") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found.");
        return;
      }
      if (code && url.searchParams.get("state") === this.state) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          `<h1>${escapeHtml(this.providerName)} connected</h1>` +
          "<p>You can close this tab and return to the terminal.</p>",
        );
        if (this.timeout) clearTimeout(this.timeout);
        this.resolveCode?.(code);
      } else if (error && url.searchParams.get("state") === this.state) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(`${this.providerName} authorization failed.`);
        if (this.timeout) clearTimeout(this.timeout);
        this.rejectCode?.(new Error("OAuth provider rejected authorization."));
      } else {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(`${this.providerName} authorization failed.`);
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, "127.0.0.1", resolve);
    });
    this.timeout = setTimeout(() => {
      this.rejectCode?.(new Error("OAuth authorization timed out."));
      this.close();
    }, 5 * 60_000);
    this.timeout.unref();
  }

  close(): void {
    if (this.timeout) clearTimeout(this.timeout);
    this.server?.close();
  }
}

export async function openBrowser(url: URL): Promise<boolean> {
  const command =
    process.platform === "darwin" ? ["open", url.toString()] :
    process.platform === "win32" ? ["cmd", "/c", "start", "", url.toString()] :
    ["xdg-open", url.toString()];
  return new Promise<boolean>((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

export async function secureTokenDirectory(path = DEFAULT_TOKEN_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] || character);
}
