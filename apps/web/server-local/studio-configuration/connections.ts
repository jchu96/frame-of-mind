import {
  DEFAULT_GRANOLA_TOKEN_PATH,
  DEFAULT_TOKEN_PATH,
  FileOAuthProvider,
  resolveMcpEndpoint,
} from "../../../../src/adapters/bluedot-oauth.js";
import {
  BluedotClient,
  DEFAULT_BLUEDOT_MCP_URL,
} from "../../../../src/adapters/bluedot-mcp.js";
import {
  DEFAULT_GRANOLA_MCP_URL,
  GranolaClient,
} from "../../../../src/adapters/granola-mcp.js";
import {
  configurationStatusSchema,
  type ConfigurationStatus,
} from "../../../../src/domain/studio-schemas.js";
import type {
  RuntimeSecretName,
  RuntimeSecretResolver,
} from "../../../../src/domain/studio-ports.js";
import { getRuntimeSecretResolver } from "./runtime-secrets.js";

export type OAuthProviderName = "bluedot" | "granola";
type OAuthPresence = (provider: OAuthProviderName) => boolean;
type OAuthConnector = (provider: OAuthProviderName) => Promise<void>;

export function storedOAuthPresent(provider: OAuthProviderName): boolean {
  const isBluedot = provider === "bluedot";
  const endpoint = resolveMcpEndpoint(
    provider,
    process.env[isBluedot ? "BLUEDOT_MCP_URL" : "GRANOLA_MCP_URL"],
    isBluedot ? DEFAULT_BLUEDOT_MCP_URL : DEFAULT_GRANOLA_MCP_URL,
    isBluedot ? DEFAULT_TOKEN_PATH : DEFAULT_GRANOLA_TOKEN_PATH,
  );
  const state = new FileOAuthProvider(
    "http://127.0.0.1/unused",
    endpoint.tokenPath,
    () => {},
    "status-only",
    endpoint.url.toString(),
    endpoint.canonical,
  );
  return state.tokens() !== undefined;
}

async function connectOAuth(provider: OAuthProviderName): Promise<void> {
  const client = provider === "bluedot"
    ? new BluedotClient(process.env.BLUEDOT_MCP_URL)
    : new GranolaClient(process.env.GRANOLA_MCP_URL);
  try {
    await client.connect();
  } finally {
    await client.close();
  }
}

export class StudioConnectionService {
  readonly #lastVerified = new Map<OAuthProviderName, string>();
  readonly #failureCode = new Map<OAuthProviderName, string>();
  readonly #inFlight = new Set<OAuthProviderName>();

  constructor(
    private readonly secrets: RuntimeSecretResolver,
    private readonly oauthPresence: OAuthPresence = storedOAuthPresent,
    private readonly oauthConnector: OAuthConnector = connectOAuth,
  ) {}

  #oauthStatus(provider: OAuthProviderName): boolean {
    try {
      const present = this.oauthPresence(provider);
      if (this.#failureCode.get(provider) === "oauth_status_failed") {
        this.#failureCode.delete(provider);
      }
      return present;
    } catch {
      this.#failureCode.set(provider, "oauth_status_failed");
      return false;
    }
  }

  async status(): Promise<ConfigurationStatus> {
    const gemini = await this.secrets.status("gemini-api-key");
    const granolaKey = await this.secrets.status("granola-api-key");
    const bluedotOAuth = this.#oauthStatus("bluedot");
    const granolaOAuth = granolaKey.present
      ? false
      : this.#oauthStatus("granola");
    const granolaUsesOAuth = !granolaKey.present && granolaOAuth;

    return configurationStatusSchema.parse({
      studioEnabled: true,
      providers: [
        {
          provider: "gemini",
          connected: gemini.present,
          source: gemini.source,
          lifetime: gemini.present ? "process" : "none",
        },
        {
          provider: "bluedot",
          connected: bluedotOAuth,
          source: bluedotOAuth ? "oauth" : "none",
          lifetime: bluedotOAuth ? "persistent-oauth" : "none",
          ...(this.#lastVerified.has("bluedot")
            ? { lastVerifiedAt: this.#lastVerified.get("bluedot") }
            : {}),
          ...(this.#failureCode.has("bluedot")
            ? { failureCode: this.#failureCode.get("bluedot") }
            : {}),
        },
        {
          provider: "granola",
          connected: granolaKey.present || granolaOAuth,
          source: granolaKey.present
            ? granolaKey.source
            : granolaUsesOAuth ? "oauth" : "none",
          lifetime: granolaKey.present
            ? "process"
            : granolaUsesOAuth ? "persistent-oauth" : "none",
          ...(granolaUsesOAuth && this.#lastVerified.has("granola")
            ? { lastVerifiedAt: this.#lastVerified.get("granola") }
            : {}),
          ...(!granolaKey.present && this.#failureCode.has("granola")
            ? { failureCode: this.#failureCode.get("granola") }
            : {}),
        },
      ],
    });
  }

  async setSessionSecret(
    name: RuntimeSecretName,
    value: string,
  ): Promise<ConfigurationStatus> {
    await this.secrets.setSession(name, value);
    return this.status();
  }

  async clearSessionSecret(
    name: RuntimeSecretName,
  ): Promise<ConfigurationStatus> {
    await this.secrets.clearSession(name);
    return this.status();
  }

  startOAuth(provider: OAuthProviderName): boolean {
    if (this.#inFlight.has(provider)) return false;
    this.#inFlight.add(provider);
    this.#failureCode.delete(provider);
    void this.oauthConnector(provider).then(() => {
      this.#lastVerified.set(provider, new Date().toISOString());
      this.#failureCode.delete(provider);
    }).catch(() => {
      this.#failureCode.set(provider, "oauth_connection_failed");
    }).finally(() => {
      this.#inFlight.delete(provider);
    });
    return true;
  }
}

let configuredConnections: StudioConnectionService | undefined;

export function getStudioConnectionService(): StudioConnectionService {
  configuredConnections ??= new StudioConnectionService(
    getRuntimeSecretResolver(),
  );
  return configuredConnections;
}
