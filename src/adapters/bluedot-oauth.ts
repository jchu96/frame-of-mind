import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

interface StoredOAuth {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

export function configRoot(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

export const DEFAULT_TOKEN_PATH = join(configRoot(), "frame-of-mind", "bluedot-oauth.json");
export const DEFAULT_GRANOLA_TOKEN_PATH = join(configRoot(), "frame-of-mind", "granola-oauth.json");

export class FileOAuthProvider implements OAuthClientProvider {
  readonly clientMetadata: OAuthClientMetadata;
  readonly redirectUrl: string;
  private stored: StoredOAuth;

  constructor(
    redirectUrl: string,
    private readonly tokenPath: string,
    private readonly onRedirect: (url: URL) => void,
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
      this.stored = JSON.parse(readFileSync(tokenPath, "utf8")) as StoredOAuth;
    } catch {
      this.stored = {};
    }
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

  private persist(): void {
    mkdirSync(dirname(this.tokenPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.tokenPath, `${JSON.stringify(this.stored, null, 2)}\n`, { mode: 0o600 });
  }
}

export class OAuthCallback {
  private server?: Server;
  private resolveCode?: (code: string) => void;
  private rejectCode?: (error: Error) => void;
  readonly code: Promise<string>;

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
      if (code) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          `<h1>${escapeHtml(this.providerName)} connected</h1>` +
          "<p>You can close this tab and return to the terminal.</p>",
        );
        this.resolveCode?.(code);
      } else {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(`${this.providerName} authorization failed.`);
        this.rejectCode?.(new Error(error || "OAuth callback did not include a code."));
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, "127.0.0.1", resolve);
    });
  }

  close(): void {
    this.server?.close();
  }
}

export async function openBrowser(url: URL): Promise<void> {
  const command =
    process.platform === "darwin" ? ["open", url.toString()] :
    process.platform === "win32" ? ["cmd", "/c", "start", "", url.toString()] :
    ["xdg-open", url.toString()];
  await new Promise<void>((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: "ignore" });
    child.once("error", () => resolve());
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
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
