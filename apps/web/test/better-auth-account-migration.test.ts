import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";

const migration = (name: string) => readFileSync(
  new URL(`../db/migrations/${name}`, import.meta.url), "utf8",
);
const upgrade = migration("0013_better_auth_provider_identity.sql");

function applyUpgrade(db: Database): void {
  // Execute statements separately, as the D1 migration runner does. Bun 1.3.14
  // can swallow a middle-statement error in one multi-statement exec call.
  for (const statement of upgrade.replace(/^--.*$/gm, "").split(";")) {
    if (statement.trim()) db.exec(statement);
  }
}

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
  // Review 2026-11-13: migration 0013 can cascade-delete incoming references.
  // Retire this restriction when the account rebuild preserves referencing rows.
  test("all migrations keep better_auth_account free of incoming foreign keys", () => {
    const files = readdirSync(new URL("../db/migrations/", import.meta.url), {
      recursive: true,
    }).filter((name) => name.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      for (const name of files) {
        db.transaction(() => db.exec(migration(name)))();
        const references = db.query(`
          SELECT schema.name AS child_table, fk."from" AS child_column
          FROM sqlite_schema AS schema, pragma_foreign_key_list(schema.name) AS fk
          WHERE schema.type = 'table' AND lower(fk."table") = 'better_auth_account'
        `).all();
        expect(references, `${name} must not reference better_auth_account`).toEqual([]);
      }
      expect(db.query("SELECT name FROM sqlite_schema WHERE name = 'better_auth_account'").all())
        .toEqual([{ name: "better_auth_account" }]);
    } finally {
      db.close();
    }
  });

  test("preserves existing ownership and accepts issuer-free accounts with provider isolation", () => {
    const db = fixture();
    try {
      const before = db.query("SELECT * FROM better_auth_account").all();
      db.transaction(() => applyUpgrade(db))();
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
      expect(() => db.transaction(() => applyUpgrade(db))()).toThrow(/UNIQUE/);
      expect(db.query("SELECT * FROM better_auth_account ORDER BY id").all()).toEqual(before);
    } finally {
      db.close();
    }
  });
});
