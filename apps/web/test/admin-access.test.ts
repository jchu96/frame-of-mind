import { describe, expect, test } from "bun:test";
import {
  AccessTransitionError,
  decideAccessTransition,
  parseMaintainerAllowlist,
} from "../server/utils/access-membership";

describe("admin access policy", () => {
  test("parses the maintainer allowlist fail-closed and normalizes case and whitespace", () => {
    expect([...parseMaintainerAllowlist(undefined)]).toEqual([]);
    expect([...parseMaintainerAllowlist("")]).toEqual([]);
    expect([...parseMaintainerAllowlist(" , \t,\n")]).toEqual([]);
    expect([...parseMaintainerAllowlist(
      " Maintainer@Example.Test,SECOND@example.test, maintainer@example.test ",
    )]).toEqual(["maintainer@example.test", "second@example.test"]);
  });

  test("allows only the documented transitions and makes replays idempotent", () => {
    expect(decideAccessTransition({
      action: "approve",
      currentState: "requested",
      approvedCount: 1,
    })).toEqual({ state: "approved", idempotent: false });
    expect(decideAccessTransition({
      action: "approve",
      currentState: "revoked",
      approvedCount: 1,
    })).toEqual({ state: "approved", idempotent: false });
    expect(decideAccessTransition({
      action: "approve",
      currentState: "approved",
      approvedCount: 1,
    })).toEqual({ state: "approved", idempotent: true });
    expect(decideAccessTransition({
      action: "deny",
      currentState: "requested",
      approvedCount: 1,
    })).toEqual({ state: "revoked", idempotent: false });
    expect(decideAccessTransition({
      action: "deny",
      currentState: "revoked",
      approvedCount: 1,
    })).toEqual({ state: "revoked", idempotent: true });
    expect(decideAccessTransition({
      action: "revoke",
      currentState: "approved",
      approvedCount: 2,
    })).toEqual({ state: "revoked", idempotent: false });
    expect(decideAccessTransition({
      action: "revoke",
      currentState: "revoked",
      approvedCount: 1,
    })).toEqual({ state: "revoked", idempotent: true });
    expect(() => decideAccessTransition({
      action: "deny",
      currentState: "approved",
      approvedCount: 2,
    })).toThrow(AccessTransitionError);
    expect(() => decideAccessTransition({
      action: "revoke",
      currentState: "requested",
      approvedCount: 2,
    })).toThrow(AccessTransitionError);
  });

  test("refuses to revoke the last approved member", () => {
    try {
      decideAccessTransition({
        action: "revoke",
        currentState: "approved",
        approvedCount: 1,
      });
      throw new Error("Expected last-member refusal.");
    } catch (error) {
      expect(error).toBeInstanceOf(AccessTransitionError);
      expect((error as AccessTransitionError).code).toBe("admin_access_last_member");
    }
  });
});
