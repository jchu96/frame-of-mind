import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

const migration = (name: string) => readFileSync(
  new URL(`../db/migrations/${name}`, import.meta.url), "utf8",
);
const upgrade = migration("0013_better_auth_provider_identity.sql");

function fixture(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(migration("0006_better_auth.sql"));
  db.exec(`INSERT INTO better_auth_user
    (id, name, email, email_verified, created_at, updated_at)
    VALUES ('user-a', 'Fixture', 'fixture@example.test', 1, '2026-11-12', '2026-11-12')`);
  db.exec(`INSERT INTO better_auth_account
    (id, account_id, provider_id, issuer, user_id, scope, created_at, updated_at)
    VALUES ('old-account', 'subject-a', 'github', 'https://github.com',
      'user-a', 'user:email', '2026-11-12', '2026-11-12')`);
  return db;
}

describe("Better Auth provider identity migration", () => {
  test("preserves existing ownership and accepts issuer-free accounts with provider isolation", () => {
    const db = fixture();
    try {
      const before = db.query("SELECT * FROM better_auth_account").all();
      db.transaction(() => db.exec(upgrade))();
      expect(db.query("SELECT * FROM better_auth_account").all()).toEqual(before);
      const insert = db.prepare(`INSERT INTO better_auth_account
        (id, account_id, provider_id, user_id, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, '2026-11-12', '2026-11-12')`);
      expect(() => insert.run("new-account", "subject-b", "github", "user-a")).not.toThrow();
      expect(() => insert.run("duplicate", "subject-a", "github", "user-a")).toThrow(/UNIQUE/);
      expect(() => insert.run("other-provider", "subject-a", "fixture-other", "user-a")).not.toThrow();
      expect(() => insert.run("orphan", "subject-c", "github", "missing-user")).toThrow(/FOREIGN KEY/);
      db.exec("DELETE FROM better_auth_user WHERE id = 'user-a'");
      expect(db.query("SELECT * FROM better_auth_account").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("refuses ambiguous legacy provider identities without deleting either account", () => {
    const db = fixture();
    try {
      db.exec(`INSERT INTO better_auth_account
        (id, account_id, provider_id, issuer, user_id, created_at, updated_at)
        VALUES ('conflict', 'subject-a', 'github', 'https://other.example.test',
          'user-a', '2026-11-12', '2026-11-12')`);
      const before = db.query("SELECT * FROM better_auth_account ORDER BY id").all();
      expect(() => db.transaction(() => db.exec(upgrade))()).toThrow(/UNIQUE/);
      expect(db.query("SELECT * FROM better_auth_account ORDER BY id").all()).toEqual(before);
    } finally {
      db.close();
    }
  });
});
