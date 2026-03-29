import { resolve } from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

let _db: ReturnType<typeof createDb> | null = null;

function defaultDbPath() {
  // Always resolve relative to the monorepo root so all packages share one db
  const walletCoreSrc = fileURLToPath(new URL(".", import.meta.url));
  return resolve(walletCoreSrc, "../../../..", "gentwallet.db");
}

function createDb(dbPath?: string) {
  const sqlite = new Database(dbPath ?? process.env.DB_PATH ?? defaultDbPath());
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;

export function getDb(dbPath?: string): Db {
  if (!_db) {
    _db = createDb(dbPath);
  }
  return _db;
}

export function createTestDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

export function initializeSchema(db: Db) {
  // Run raw SQL to create tables — simpler than migrations for MVP
  const sqlite = (db as any).session.client as Database.Database;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      held_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      entry_type TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      running_balance INTEGER NOT NULL,
      reference_type TEXT,
      reference_id TEXT,
      description TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS virtual_cards (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      last_four TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS spending_rules (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      rule_type TEXT NOT NULL,
      value_cents INTEGER,
      mcc_codes TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS authorization_log (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      card_id TEXT,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      merchant_name TEXT NOT NULL,
      merchant_category TEXT,
      decision TEXT NOT NULL,
      decline_reason TEXT,
      hold_id TEXT,
      decided_in_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      merchant_name TEXT,
      merchant_category TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      authorization_log_id TEXT REFERENCES authorization_log(id),
      rule_id TEXT REFERENCES spending_rules(id),
      message TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
