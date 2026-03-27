import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const wallets = sqliteTable("wallets", {
  id: text("id").primaryKey(),
  balanceCents: integer("balance_cents").notNull().default(0),
  heldCents: integer("held_cents").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const ledgerEntries = sqliteTable("ledger_entries", {
  id: text("id").primaryKey(),
  walletId: text("wallet_id")
    .notNull()
    .references(() => wallets.id),
  entryType: text("entry_type").notNull(), // top_up, hold, capture, release, refund
  amountCents: integer("amount_cents").notNull(),
  runningBalance: integer("running_balance").notNull(),
  referenceType: text("reference_type"), // hold, authorization, etc.
  referenceId: text("reference_id"),
  description: text("description"),
  metadata: text("metadata"), // JSON
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const virtualCards = sqliteTable("virtual_cards", {
  id: text("id").primaryKey(),
  walletId: text("wallet_id")
    .notNull()
    .references(() => wallets.id),
  lastFour: text("last_four").notNull(),
  status: text("status").notNull().default("active"), // active, frozen, cancelled
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const spendingRules = sqliteTable("spending_rules", {
  id: text("id").primaryKey(),
  walletId: text("wallet_id")
    .notNull()
    .references(() => wallets.id),
  ruleType: text("rule_type").notNull(), // auto_approve_threshold, notify_over, category_block, daily_limit
  valueCents: integer("value_cents"),
  mccCodes: text("mcc_codes"), // JSON array
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const authorizationLog = sqliteTable("authorization_log", {
  id: text("id").primaryKey(),
  walletId: text("wallet_id")
    .notNull()
    .references(() => wallets.id),
  cardId: text("card_id"),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("USD"),
  merchantName: text("merchant_name").notNull(),
  merchantCategory: text("merchant_category"), // MCC code
  decision: text("decision").notNull(), // approved, declined
  declineReason: text("decline_reason"),
  holdId: text("hold_id"),
  decidedInMs: integer("decided_in_ms"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const holds = sqliteTable("holds", {
  id: text("id").primaryKey(),
  walletId: text("wallet_id")
    .notNull()
    .references(() => wallets.id),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").notNull().default("active"), // active, captured, released
  merchantName: text("merchant_name"),
  merchantCategory: text("merchant_category"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  walletId: text("wallet_id")
    .notNull()
    .references(() => wallets.id),
  authorizationLogId: text("authorization_log_id").references(
    () => authorizationLog.id
  ),
  ruleId: text("rule_id").references(() => spendingRules.id),
  message: text("message").notNull(),
  read: integer("read", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});
