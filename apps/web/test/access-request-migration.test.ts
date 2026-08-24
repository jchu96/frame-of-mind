import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function migration(name: string): string {
  return readFileSync(resolve("apps/web/db/migrations", name), "utf8");
}

describe("access-request migration", () => {
  test("backfills existing invitations as approved and creates bounded request state", () => {
    const database = new Database(":memory:");
    try {
      database.exec(migration("0006_better_auth.sql"));
      database.exec(migration("0009_magic_link_cooldown.sql"));
      database.run(
        "INSERT INTO hosted_auth_invites (email, invited_at) VALUES (?1, ?2)",
        ["existing@example.test", "2026-08-23T00:00:00.000Z"],
      );

      database.exec(migration("0010_access_requests.sql"));
      database.exec(migration("0011_admin_access.sql"));

      expect(database.query(
        "SELECT state, requested_at, approved_at, decided_by, actioned_by, actioned_at "
        + "FROM hosted_auth_invites WHERE email = ?1",
      ).get("existing@example.test")).toEqual({
        state: "approved",
        requested_at: null,
        approved_at: "2026-08-23T00:00:00.000Z",
        decided_by: null,
        actioned_by: null,
        actioned_at: null,
      });
      database.run(
        "INSERT INTO hosted_auth_invites "
        + "(email, invited_at, state, requested_at) VALUES (?1, ?2, 'requested', ?2)",
        ["requester@example.test", "2026-08-23T01:00:00.000Z"],
      );
      expect(() => database.run(
        "UPDATE hosted_auth_invites SET state = 'invalid' WHERE email = ?1",
        ["requester@example.test"],
      )).toThrow();
      expect(database.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
      ).get("hosted_access_request_rate_limit")).toEqual({
        name: "hosted_access_request_rate_limit",
      });
    } finally {
      database.close();
    }
  });
});
