import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  LOCAL_STUDIO_BOOTSTRAP_FRAGMENT,
} from "./contract.js";

export {
  LOCAL_STUDIO_BOOTSTRAP_FRAGMENT,
  LOCAL_STUDIO_BOOTSTRAP_PATH,
  LOCAL_STUDIO_CLEAN_PATH,
  LOCAL_STUDIO_COOKIE_NAME,
} from "./contract.js";

const MIN_CAPABILITY_LENGTH = 32;
let configuredSession: LocalStudioSession | undefined;

function assertCapability(value: string, label: string): void {
  if (
    value.length < MIN_CAPABILITY_LENGTH
    || value.length > 512
    || /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes);
}

export function generateStudioCapability(): string {
  return randomBytes(32).toString("base64url");
}

export class LocalStudioSession {
  readonly #bootstrapToken: string;
  readonly #sessionToken: string;
  #bootstrapUsed = false;

  constructor(input: {
    bootstrapToken: string;
    sessionToken?: string;
  }) {
    assertCapability(input.bootstrapToken, "Bootstrap capability");
    const sessionToken = input.sessionToken ?? generateStudioCapability();
    assertCapability(sessionToken, "Session capability");
    this.#bootstrapToken = input.bootstrapToken;
    this.#sessionToken = sessionToken;
  }

  exchangeBootstrap(candidate: string): string {
    if (!secureEqual(candidate, this.#bootstrapToken)) {
      throw new Error("Bootstrap capability is invalid.");
    }
    if (this.#bootstrapUsed) {
      throw new Error("Bootstrap capability was already used.");
    }
    this.#bootstrapUsed = true;
    return this.#sessionToken;
  }

  isAuthorized(candidate: string | undefined): boolean {
    return candidate !== undefined && secureEqual(candidate, this.#sessionToken);
  }
}

export function getConfiguredLocalStudioSession(): LocalStudioSession {
  if (configuredSession) return configuredSession;
  const bootstrapToken = process.env.FRAME_OF_MIND_STUDIO_BOOTSTRAP_TOKEN;
  if (!bootstrapToken) {
    throw new Error("Local Studio bootstrap is not configured.");
  }
  configuredSession = new LocalStudioSession({ bootstrapToken });
  return configuredSession;
}

export function localStudioCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    path: "/",
    secure: false,
  };
}

export function shouldRegisterLocalStudioRoutes(
  nitroPreset: string,
  enabled: boolean,
): boolean {
  return nitroPreset === "node-server" && enabled;
}

export function requiresLocalStudioSession(path: string): boolean {
  return path === "/connections" || path.startsWith("/api/studio/");
}

export function redactStudioBootstrap(
  value: string,
  sensitiveValues: readonly string[] = [],
): string {
  let redacted = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive) redacted = redacted.replaceAll(sensitive, "[REDACTED]");
  }
  redacted = redacted.replace(
    /([?&]token=)[^&#\s]*/gi,
    "$1%5BREDACTED%5D",
  );
  redacted = redacted.replace(
    /(#studio-bootstrap=)[^&\s]*/gi,
    "$1%5BREDACTED%5D",
  );
  return redacted;
}
