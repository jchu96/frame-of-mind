import { describe, expect, test } from "bun:test";
import {
  LOCAL_STUDIO_COOKIE_NAME,
  LocalStudioSession,
  localStudioCookieOptions,
  redactStudioBootstrap,
  shouldRegisterLocalStudioRoutes,
} from "../server-local/studio-session/session";

const bootstrapToken = "bootstrap_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

describe("local Studio per-launch session", () => {
  test("exchanges the bootstrap capability once and rejects replay", () => {
    const sessions = new LocalStudioSession({
      bootstrapToken,
      sessionToken: "session_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
    });

    const sessionToken = sessions.exchangeBootstrap(bootstrapToken);
    expect(sessions.isAuthorized(sessionToken)).toBe(true);
    expect(() => sessions.exchangeBootstrap(bootstrapToken)).toThrow(
      /already used/i,
    );
    expect(() => sessions.exchangeBootstrap("wrong-capability")).toThrow(
      /invalid/i,
    );
  });

  test("uses an HttpOnly SameSite Strict process-session cookie", () => {
    expect(LOCAL_STUDIO_COOKIE_NAME).toBe("frame_of_mind_studio");
    expect(localStudioCookieOptions()).toEqual({
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      secure: false,
    });
    expect(localStudioCookieOptions()).not.toHaveProperty("maxAge");
    expect(localStudioCookieOptions()).not.toHaveProperty("expires");
  });

  test("redacts bootstrap material from URLs and arbitrary log text", () => {
    const dirtyUrl =
      `http://127.0.0.1:3000/#studio-bootstrap=${bootstrapToken}`;
    expect(redactStudioBootstrap(dirtyUrl, [bootstrapToken])).toBe(
      "http://127.0.0.1:3000/#studio-bootstrap=%5BREDACTED%5D",
    );
    expect(redactStudioBootstrap(
      `bootstrap failed for ${bootstrapToken}`,
      [bootstrapToken],
    )).toBe("bootstrap failed for [REDACTED]");
  });

  test("registers local control routes only in an enabled node-server build", () => {
    expect(shouldRegisterLocalStudioRoutes("node-server", true)).toBe(true);
    expect(shouldRegisterLocalStudioRoutes("cloudflare", true)).toBe(false);
    expect(shouldRegisterLocalStudioRoutes("cloudflare-worker", true)).toBe(false);
    expect(shouldRegisterLocalStudioRoutes("node-server", false)).toBe(false);
  });
});
